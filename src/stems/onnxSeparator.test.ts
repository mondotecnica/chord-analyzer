import { describe, expect, it, vi } from "vitest";
import { OnnxStemSeparator, type WorkerLike } from "./onnxSeparator";
import { STEM_NAMES } from "./config";
import type { ModelStore } from "./modelCache";
import {
  SeparationCancelledError,
  type SeparationProgress,
  type StereoAudio,
} from "./types";
import type { WorkerRequest, WorkerResponse } from "./workerProtocol";

/** テスト用のインメモリ ModelStore */
class MapStore implements ModelStore {
  readonly data = new Map<string, ArrayBuffer>();
  async match(url: string): Promise<ArrayBuffer | undefined> {
    return this.data.get(url);
  }
  async put(url: string, buffer: ArrayBuffer): Promise<boolean> {
    this.data.set(url, buffer);
    return true;
  }
}

/**
 * 偽 Worker で分離オーケストレーション（モデル取得 → init →
 * チャンク往復 → 合成 → 後片付け）を検証する。
 * 実推論は行わない（ブラウザ実機での未検証項目、MODES.md §8）。
 */
class FakeWorker implements WorkerLike {
  terminated = false;
  private listeners = new Set<(e: MessageEvent<WorkerResponse>) => void>();
  private errorListeners = new Set<(e: Event) => void>();
  /** "echo" = 入力をそのまま全ステムに返す、"silent-chunk" = チャンクに応答しない、
   *  "crash-*" = 応答を返さず error イベントで死ぬ（Worker クラッシュの再現） */
  mode:
    | "echo"
    | "error-init"
    | "error-chunk"
    | "silent-chunk"
    | "crash-init"
    | "crash-chunk" = "echo";

  postMessage(message: WorkerRequest): void {
    if (message.type === "init") {
      queueMicrotask(() => {
        if (this.mode === "error-init") {
          this.emit({ type: "error", stage: "runtime-init", message: "init boom" });
        } else if (this.mode === "crash-init") {
          this.emitCrash();
        } else {
          this.emit({ type: "ready", providers: ["wasm"] });
        }
      });
      return;
    }
    if (message.type === "chunk") {
      if (this.mode === "silent-chunk") return;
      queueMicrotask(() => {
        if (this.mode === "error-chunk") {
          this.emit({ type: "error", stage: "inference", message: "infer boom" });
          return;
        }
        if (this.mode === "crash-chunk") {
          this.emitCrash();
          return;
        }
        // 全ステム = 入力そのもの（合成が恒等になる組み立て）
        const channels: Float32Array[] = [];
        for (let s = 0; s < STEM_NAMES.length; s++) {
          channels.push(new Float32Array(message.left));
          channels.push(new Float32Array(message.right));
        }
        this.emit({ type: "chunk-done", index: message.index, channels });
      });
    }
  }

  terminate(): void {
    this.terminated = true;
  }

  addEventListener(
    type: "message",
    listener: (e: MessageEvent<WorkerResponse>) => void,
  ): void;
  addEventListener(type: "error", listener: (e: Event) => void): void;
  addEventListener(
    type: "message" | "error",
    listener:
      | ((e: MessageEvent<WorkerResponse>) => void)
      | ((e: Event) => void),
  ): void {
    if (type === "message") {
      this.listeners.add(listener as (e: MessageEvent<WorkerResponse>) => void);
    } else {
      this.errorListeners.add(listener as (e: Event) => void);
    }
  }

  removeEventListener(
    type: "message",
    listener: (e: MessageEvent<WorkerResponse>) => void,
  ): void;
  removeEventListener(type: "error", listener: (e: Event) => void): void;
  removeEventListener(
    type: "message" | "error",
    listener:
      | ((e: MessageEvent<WorkerResponse>) => void)
      | ((e: Event) => void),
  ): void {
    if (type === "message") {
      this.listeners.delete(listener as (e: MessageEvent<WorkerResponse>) => void);
    } else {
      this.errorListeners.delete(listener as (e: Event) => void);
    }
  }

  private emit(res: WorkerResponse): void {
    for (const l of [...this.listeners]) {
      l({ data: res } as MessageEvent<WorkerResponse>);
    }
  }

  /** Worker が応答を返さずに死ぬ状態（error イベント）を再現する */
  private emitCrash(): void {
    for (const l of [...this.errorListeners]) {
      l(new Event("error"));
    }
  }
}

const MODEL_BYTES = new Uint8Array([1, 2, 3, 4]);

function okFetch(): typeof fetch {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    body: null,
    arrayBuffer: async () => MODEL_BYTES.buffer,
  })) as unknown as typeof fetch;
}

function makeSeparator(worker: FakeWorker): OnnxStemSeparator {
  return new OnnxStemSeparator({
    workerFactory: () => worker,
    fetchImpl: okFetch(),
    environment: { hasWebGPU: false, hasWasm: true },
    model: { url: "https://example.test/model.onnx", expectedBytes: 4 },
  });
}

function testInput(length = 1000): StereoAudio {
  const left = new Float32Array(length);
  const right = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    left[i] = Math.sin(i * 0.01);
    right[i] = Math.cos(i * 0.01);
  }
  return { left, right, sampleRate: 44100 };
}

describe("OnnxStemSeparator", () => {
  it("正常系: モデル取得 → 分離 → 合成までを通し、進捗を段階順に出す", async () => {
    const worker = new FakeWorker();
    const separator = makeSeparator(worker);
    const input = testInput();
    const progresses: SeparationProgress[] = [];
    const result = await separator.separate(input, {
      onProgress: (p) => progresses.push(p),
    });

    expect(result.sampleRate).toBe(44100);
    for (const name of STEM_NAMES) {
      // 偽 Worker は入力をそのまま返すため、合成結果は入力と一致する
      expect(Array.from(result.stems[name].left)).toEqual(Array.from(input.left));
      expect(Array.from(result.stems[name].right)).toEqual(Array.from(input.right));
    }
    const stages = progresses.map((p) => p.stage);
    expect(stages).toContain("model-download");
    expect(stages.at(-1)).toBe("separating");
    expect(progresses.at(-1)?.ratio).toBe(1);
    expect(worker.terminated).toBe(true);
    expect(separator.modelId).toBe("htdemucs");
  });

  it("実測時間（timings）を結果に付け、プロバイダは ready 応答由来にする", async () => {
    const worker = new FakeWorker();
    const separator = makeSeparator(worker);
    const result = await separator.separate(testInput());
    expect(result.timings).toBeDefined();
    expect(result.timings!.modelDownloadSeconds).toBeGreaterThanOrEqual(0);
    expect(result.timings!.separationSeconds).toBeGreaterThanOrEqual(0);
    // 偽 Worker の ready 応答は providers: ["wasm"]
    expect(result.timings!.provider).toBe("wasm");
  });

  it("キャッシュ済みモデルでは進捗が fromCache: true になり、結果にも残る", async () => {
    const worker = new FakeWorker();
    const store = new MapStore();
    store.data.set(
      "https://example.test/model.onnx",
      new Uint8Array([1, 2, 3, 4]).buffer,
    );
    const separator = new OnnxStemSeparator({
      workerFactory: () => worker,
      fetchImpl: vi.fn(() => {
        throw new Error("fetch should not be called");
      }) as unknown as typeof fetch,
      environment: { hasWebGPU: false, hasWasm: true },
      model: { url: "https://example.test/model.onnx", expectedBytes: 4 },
      modelStore: store,
      cacheRecordStorage: null,
    });
    const progresses: SeparationProgress[] = [];
    const result = await separator.separate(testInput(), {
      onProgress: (p) => progresses.push(p),
    });
    const downloadEvents = progresses.filter(
      (p) => p.stage === "model-download",
    );
    expect(downloadEvents.length).toBeGreaterThan(0);
    expect(downloadEvents.every((p) => p.fromCache === true)).toBe(true);
    expect(result.modelFetch).toEqual({
      source: "cache",
      persisted: null,
      cacheLost: false,
    });
  });

  it("ダウンロード時は進捗が fromCache: false で、保存結果が結果に残る", async () => {
    const worker = new FakeWorker();
    const store = new MapStore();
    const separator = new OnnxStemSeparator({
      workerFactory: () => worker,
      fetchImpl: okFetch(),
      environment: { hasWebGPU: false, hasWasm: true },
      model: { url: "https://example.test/model.onnx", expectedBytes: 4 },
      modelStore: store,
      cacheRecordStorage: null,
    });
    const progresses: SeparationProgress[] = [];
    const result = await separator.separate(testInput(), {
      onProgress: (p) => progresses.push(p),
    });
    const downloadEvents = progresses.filter(
      (p) => p.stage === "model-download",
    );
    expect(downloadEvents.length).toBeGreaterThan(0);
    expect(downloadEvents.every((p) => p.fromCache === false)).toBe(true);
    expect(result.modelFetch).toEqual({
      source: "download",
      persisted: true,
      cacheLost: false,
    });
    expect(store.data.has("https://example.test/model.onnx")).toBe(true);
  });

  it("保存先が無い構成では modelFetch.persisted が null になる", async () => {
    const worker = new FakeWorker();
    const separator = makeSeparator(worker);
    const result = await separator.separate(testInput());
    expect(result.modelFetch).toEqual({
      source: "download",
      persisted: null,
      cacheLost: false,
    });
  });

  it("モデル取得の失敗は SeparationError（model-download）で伝わる", async () => {
    const worker = new FakeWorker();
    const separator = new OnnxStemSeparator({
      workerFactory: () => worker,
      fetchImpl: vi.fn(async () => {
        throw new TypeError("network down");
      }) as unknown as typeof fetch,
      environment: { hasWebGPU: false, hasWasm: true },
      model: { url: "https://example.test/model.onnx", expectedBytes: 4 },
    });
    await expect(separator.separate(testInput())).rejects.toMatchObject({
      name: "SeparationError",
      stage: "model-download",
    });
  });

  it("Worker の初期化エラーは SeparationError（runtime-init）で伝わる", async () => {
    const worker = new FakeWorker();
    worker.mode = "error-init";
    const separator = makeSeparator(worker);
    await expect(separator.separate(testInput())).rejects.toMatchObject({
      name: "SeparationError",
      stage: "runtime-init",
    });
    expect(worker.terminated).toBe(true);
  });

  it("推論エラーは SeparationError（inference）で伝わる", async () => {
    const worker = new FakeWorker();
    worker.mode = "error-chunk";
    const separator = makeSeparator(worker);
    await expect(separator.separate(testInput())).rejects.toMatchObject({
      name: "SeparationError",
      stage: "inference",
    });
    expect(worker.terminated).toBe(true);
  });

  it("初期化中に Worker がクラッシュしても SeparationError（runtime-init）で settle する", async () => {
    const worker = new FakeWorker();
    worker.mode = "crash-init";
    const separator = makeSeparator(worker);
    await expect(separator.separate(testInput())).rejects.toMatchObject({
      name: "SeparationError",
      stage: "runtime-init",
    });
    expect(worker.terminated).toBe(true);
  });

  it("推論中に Worker がクラッシュしても SeparationError（inference）で settle する（無言ハング防止）", async () => {
    const worker = new FakeWorker();
    worker.mode = "crash-chunk";
    const separator = makeSeparator(worker);
    await expect(separator.separate(testInput())).rejects.toMatchObject({
      name: "SeparationError",
      stage: "inference",
    });
    expect(worker.terminated).toBe(true);
  });

  it("実行中に abort すると SeparationCancelledError になり Worker が止まる", async () => {
    const worker = new FakeWorker();
    worker.mode = "silent-chunk";
    const separator = makeSeparator(worker);
    const controller = new AbortController();
    const promise = separator.separate(testInput(), { signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await expect(promise).rejects.toBeInstanceOf(SeparationCancelledError);
    expect(worker.terminated).toBe(true);
  });

  it("WebGPU も WASM も無い環境は unsupported で即座に失敗する", async () => {
    const fetchImpl = vi.fn(() => {
      throw new Error("fetch should not be called");
    }) as unknown as typeof fetch;
    const separator = new OnnxStemSeparator({
      fetchImpl,
      environment: { hasWebGPU: false, hasWasm: false },
    });
    await expect(separator.separate(testInput())).rejects.toMatchObject({
      name: "SeparationError",
      stage: "unsupported",
    });
  });

  it("サンプルレートが 44100 でない入力は unsupported", async () => {
    const separator = makeSeparator(new FakeWorker());
    const input = testInput();
    input.sampleRate = 48000;
    await expect(separator.separate(input)).rejects.toMatchObject({
      stage: "unsupported",
    });
  });
});

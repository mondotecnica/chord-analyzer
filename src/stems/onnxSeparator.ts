import {
  CHUNK_OVERLAP_SECONDS,
  SEPARATION_MODEL,
  SEPARATION_SAMPLE_RATE,
  STEM_NAMES,
} from "./config";
import { assembleSegments, planSongChunks, type SegmentOutput } from "./chunkPlan";
import {
  detectEnvironment,
  selectExecutionProviders,
  type EnvironmentInfo,
} from "./environment";
import {
  createCacheStorageStore,
  fetchModelBuffer,
  type ModelStore,
} from "./modelCache";
import {
  SeparationCancelledError,
  SeparationError,
  type SeparateOptions,
  type SeparatedStems,
  type StemSeparator,
  type StereoAudio,
} from "./types";
import type { WorkerRequest, WorkerResponse } from "./workerProtocol";

/**
 * ONNX Runtime Web によるステム分離（メインスレッド側、MODES.md §2）。
 *
 * 責務: 環境検出 → モデル取得（Cache Storage、進捗つき）→ Worker 起動 →
 * チャンク計画と送信 → チャンク結果のクロスフェード合成 → 後片付け。
 * 推論そのものは separationWorker.ts が担う。
 *
 * 失敗はすべて SeparationError（段階つき）か SeparationCancelledError
 * として呼び出し側へ返り、UI は簡易モードへフォールバックできる。
 * 成功を装う経路は存在しない: モデル取得・ランタイム初期化・推論の
 * いずれかが失敗すれば、ステムは返らない。
 */

/** Worker の最小インタフェース（テストで偽 Worker を差し替え可能にする） */
export interface WorkerLike {
  postMessage(message: WorkerRequest, transfer?: Transferable[]): void;
  terminate(): void;
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<WorkerResponse>) => void,
  ): void;
  removeEventListener(
    type: "message",
    listener: (event: MessageEvent<WorkerResponse>) => void,
  ): void;
}

export interface OnnxStemSeparatorOptions {
  modelStore?: ModelStore;
  fetchImpl?: typeof fetch;
  workerFactory?: () => WorkerLike;
  environment?: Pick<EnvironmentInfo, "hasWebGPU" | "hasWasm">;
  /** 取得先の差し替え（ミラー利用・テスト用）。既定は config のピン留め URL */
  model?: { url: string; expectedBytes?: number };
}

function defaultWorkerFactory(): WorkerLike {
  if (typeof Worker === "undefined") {
    throw new SeparationError(
      "unsupported",
      "この環境では Web Worker が使えないため、高精度モードを実行できません。",
    );
  }
  // Worker チャンクは import.meta.url 相対で解決する（絶対パス禁止）。
  // base が相対 ('./') のビルドでは、出力先の assets/ 内相対参照になり、
  // GitHub Pages のサブパス配置でも壊れない（vite.config.ts 参照）。
  return new Worker(new URL("./separationWorker.ts", import.meta.url), {
    type: "module",
  }) as unknown as WorkerLike;
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new SeparationCancelledError();
}

export class OnnxStemSeparator implements StemSeparator {
  readonly modelId: string = SEPARATION_MODEL.id;
  private readonly options: OnnxStemSeparatorOptions;
  private worker: WorkerLike | null = null;

  constructor(options: OnnxStemSeparatorOptions = {}) {
    this.options = options;
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
  }

  async separate(
    input: StereoAudio,
    options: SeparateOptions = {},
  ): Promise<SeparatedStems> {
    const { onProgress, signal } = options;
    if (input.sampleRate !== SEPARATION_SAMPLE_RATE) {
      throw new SeparationError(
        "unsupported",
        `分離には ${SEPARATION_SAMPLE_RATE}Hz の入力が必要です（実際: ${input.sampleRate}Hz）。呼び出し側でリサンプルしてください。`,
      );
    }
    throwIfCancelled(signal);

    const env = this.options.environment ?? detectEnvironment();
    const providers = selectExecutionProviders(env);
    if (providers.length === 0) {
      throw new SeparationError(
        "unsupported",
        "このブラウザでは WebGPU / WebAssembly が使えないため、高精度モードを実行できません。",
      );
    }

    // 段階1: モデル取得（キャッシュ済みなら即時）
    let modelBuffer: ArrayBuffer;
    try {
      modelBuffer = await fetchModelBuffer({
        url: this.options.model?.url ?? SEPARATION_MODEL.url,
        expectedBytes: this.options.model
          ? this.options.model.expectedBytes
          : SEPARATION_MODEL.expectedBytes,
        store:
          this.options.modelStore ??
          (typeof caches !== "undefined"
            ? createCacheStorageStore(SEPARATION_MODEL.cacheName)
            : undefined),
        fetchImpl: this.options.fetchImpl,
        signal,
        onProgress: (p) => {
          onProgress?.({
            stage: "model-download",
            ratio: p.ratio,
            detail:
              p.totalBytes !== null
                ? `${Math.floor(p.loadedBytes / 1_000_000)}MB / ${Math.floor(p.totalBytes / 1_000_000)}MB`
                : `${Math.floor(p.loadedBytes / 1_000_000)}MB`,
          });
        },
      });
    } catch (e) {
      if (signal?.aborted) throw new SeparationCancelledError();
      throw e;
    }
    throwIfCancelled(signal);

    // 段階2: Worker 起動 + チャンク推論 + 合成
    const worker = (this.options.workerFactory ?? defaultWorkerFactory)();
    this.worker = worker;
    try {
      await this.waitForResponse(
        worker,
        (res) => res.type === "ready",
        signal,
        () => {
          worker.postMessage(
            { type: "init", modelBuffer, providers },
            [modelBuffer],
          );
        },
      );
      throwIfCancelled(signal);

      const total = input.left.length;
      const plan = planSongChunks(total, input.sampleRate);
      const fadeLength = Math.round(CHUNK_OVERLAP_SECONDS * input.sampleRate);
      const outputs: SegmentOutput[] = [];
      for (const win of plan) {
        throwIfCancelled(signal);
        const end = Math.min(win.start + win.length, total);
        const left = new Float32Array(win.length);
        left.set(input.left.subarray(win.start, end));
        const right = new Float32Array(win.length);
        right.set(input.right.subarray(win.start, end));
        const res = await this.waitForResponse(
          worker,
          (r) => r.type === "chunk-done" && r.index === win.index,
          signal,
          () => {
            worker.postMessage(
              { type: "chunk", index: win.index, left, right },
              [left.buffer as ArrayBuffer, right.buffer as ArrayBuffer],
            );
          },
        );
        if (res.type !== "chunk-done") {
          throw new SeparationError("inference", "Worker から想定外の応答が返りました。");
        }
        outputs.push({ start: win.start, channels: res.channels });
        onProgress?.({
          stage: "separating",
          ratio: (win.index + 1) / plan.length,
          detail: `${win.index + 1} / ${plan.length} チャンク`,
        });
      }

      const assembled = assembleSegments(total, outputs, fadeLength);
      const stems = {} as SeparatedStems["stems"];
      STEM_NAMES.forEach((name, i) => {
        stems[name] = { left: assembled[i * 2], right: assembled[i * 2 + 1] };
      });
      return { sampleRate: input.sampleRate, stems };
    } finally {
      worker.terminate();
      if (this.worker === worker) this.worker = null;
    }
  }

  /**
   * Worker へ送信し、条件に合う応答を待つ。
   * error 応答は SeparationError、abort は SeparationCancelledError に変換する。
   */
  private waitForResponse(
    worker: WorkerLike,
    predicate: (res: WorkerResponse) => boolean,
    signal: AbortSignal | undefined,
    send: () => void,
  ): Promise<WorkerResponse> {
    return new Promise<WorkerResponse>((resolve, reject) => {
      const cleanup = () => {
        worker.removeEventListener("message", onMessage);
        signal?.removeEventListener("abort", onAbort);
      };
      const onMessage = (event: MessageEvent<WorkerResponse>) => {
        const res = event.data;
        if (res.type === "error") {
          cleanup();
          reject(new SeparationError(res.stage, res.message));
          return;
        }
        if (!predicate(res)) return;
        cleanup();
        resolve(res);
      };
      const onAbort = () => {
        cleanup();
        reject(new SeparationCancelledError());
      };
      worker.addEventListener("message", onMessage);
      signal?.addEventListener("abort", onAbort);
      if (signal?.aborted) {
        cleanup();
        reject(new SeparationCancelledError());
        return;
      }
      try {
        send();
      } catch (e) {
        cleanup();
        reject(
          e instanceof Error
            ? e
            : new SeparationError("runtime-init", "Worker への送信に失敗しました。"),
        );
      }
    });
  }
}

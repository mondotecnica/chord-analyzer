import * as ort from "onnxruntime-web";
import {
  assembleSegments,
  modelSegmentFadeLength,
  planModelSegments,
  type SegmentOutput,
} from "./chunkPlan";
import {
  MODEL_SEGMENT_SAMPLES,
  MODEL_SPEC_BINS,
  MODEL_SPEC_FRAMES,
} from "./config";
import { combineModelOutputs, prepareModelInput } from "./demucsSignal";
import type {
  WorkerChunkRequest,
  WorkerInitRequest,
  WorkerRequest,
  WorkerResponse,
} from "./workerProtocol";

/**
 * 分離 Worker 本体（MODES.md §2.1、§2.3）。
 *
 * 役割は「ONNX セッションの保持」と「チャンク 1 つ分の推論」だけ。
 * モデル取得・チャンク計画・全体の合成はメインスレッド側
 * （onnxSeparator.ts）の責務で、ここではチャンク内をさらに
 * モデルセグメント（343,980 サンプル、重なり 25%）へ切り、
 * セグメントごとに中間テンソルを解放しながら推論する。
 *
 * 注意: このファイルの実推論はブラウザ実機でしか検証できない
 * （開発環境にブラウザ / GPU がない）。検証範囲は MODES.md §8 参照。
 *
 * WASM アセットの解決（サブパス対応の監査結果）:
 * onnxruntime-web は内部で `new URL('ort-wasm-*.wasm', self.location.href)`
 * 形式で自らの WASM を解決し、Vite がそれをアセットとして出力する。
 * ビルドの base が絶対 ('/') だと参照が '/assets/...' になり
 * GitHub Pages のサブパス配置で壊れるため、vite.config.ts で
 * base を相対 ('./') にし、参照を Worker と同じ assets/ 内の
 * 相対ファイル名に保っている。ここで ort.env.wasm.wasmPaths に
 * 絶対パスを直書きしてはいけない（同じ理由で壊れる）。
 */

interface WorkerScopeLike {
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<WorkerRequest>) => void,
  ): void;
}

const ctx = self as unknown as WorkerScopeLike;

let session: ort.InferenceSession | null = null;

function post(message: WorkerResponse, transfer?: Transferable[]): void {
  ctx.postMessage(message, transfer);
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function handleInit(req: WorkerInitRequest): Promise<void> {
  try {
    ort.env.wasm.numThreads = Math.max(
      1,
      Math.min(4, navigator.hardwareConcurrency || 1),
    );
    const options: ort.InferenceSession.SessionOptions = {
      executionProviders: [...req.providers],
      graphOptimizationLevel: "basic",
    };
    let usedProviders: string[] = [...req.providers];
    try {
      session = await ort.InferenceSession.create(req.modelBuffer, options);
    } catch (firstError) {
      // WebGPU を含む構成でセッション生成自体が失敗したら WASM のみで再試行
      if (req.providers.includes("wasm") && req.providers[0] !== "wasm") {
        session = await ort.InferenceSession.create(req.modelBuffer, {
          ...options,
          executionProviders: ["wasm"],
        });
        usedProviders = ["wasm"];
      } else {
        throw firstError;
      }
    }
    post({ type: "ready", providers: usedProviders });
  } catch (e) {
    post({
      type: "error",
      stage: "runtime-init",
      message: `ONNX ランタイムを初期化できませんでした: ${errorMessage(e)}`,
    });
  }
}

async function runModelSegment(
  activeSession: ort.InferenceSession,
  segLeft: Float32Array,
  segRight: Float32Array,
): Promise<{ left: Float32Array; right: Float32Array }[]> {
  const input = prepareModelInput(segLeft, segRight);
  const feeds: Record<string, ort.Tensor> = {};
  feeds[activeSession.inputNames[0]] = new ort.Tensor(
    "float32",
    input.waveform,
    [1, 2, MODEL_SEGMENT_SAMPLES],
  );
  if (activeSession.inputNames.length > 1) {
    feeds[activeSession.inputNames[1]] = new ort.Tensor(
      "float32",
      input.magSpec,
      [1, 4, MODEL_SPEC_BINS, MODEL_SPEC_FRAMES],
    );
  }
  const results = await activeSession.run(feeds);

  let timeData: Float32Array | null = null;
  let timeDims: readonly number[] = [];
  let freqData: Float32Array | null = null;
  for (const name of activeSession.outputNames) {
    const tensor = results[name];
    if (tensor.dims.length === 4 && tensor.dims[2] === 2) {
      timeData = tensor.data as Float32Array;
      timeDims = tensor.dims;
    } else if (tensor.dims.length === 5 && tensor.dims[2] === 4) {
      freqData = tensor.data as Float32Array;
    }
  }
  // 出力テンソルはコピー済みの combineModelOutputs の結果だけを残し、
  // セグメントごとに解放する（メモリを bound するため）
  const tracks = timeData
    ? combineModelOutputs(new Float32Array(timeData), timeDims, freqData)
    : null;
  for (const name of activeSession.outputNames) {
    const tensor = results[name] as { dispose?: () => void };
    tensor.dispose?.();
  }
  if (!tracks) {
    throw new Error("モデルの出力に時間領域テンソルが見つかりませんでした。");
  }
  return tracks;
}

async function handleChunk(req: WorkerChunkRequest): Promise<void> {
  if (!session) {
    post({
      type: "error",
      stage: "runtime-init",
      message: "モデルが初期化される前に推論が要求されました。",
    });
    return;
  }
  try {
    const total = req.left.length;
    const plan = planModelSegments(total);
    const outputs: SegmentOutput[] = [];
    for (const win of plan) {
      const segLeft = new Float32Array(MODEL_SEGMENT_SAMPLES);
      const segRight = new Float32Array(MODEL_SEGMENT_SAMPLES);
      const end = Math.min(win.start + MODEL_SEGMENT_SAMPLES, total);
      segLeft.set(req.left.subarray(win.start, end));
      segRight.set(req.right.subarray(win.start, end));
      const tracks = await runModelSegment(session, segLeft, segRight);
      outputs.push({
        start: win.start,
        channels: tracks.flatMap((t) => [t.left, t.right]),
      });
    }
    const channels = assembleSegments(total, outputs, modelSegmentFadeLength());
    post(
      { type: "chunk-done", index: req.index, channels },
      channels.map((c) => c.buffer as ArrayBuffer),
    );
  } catch (e) {
    post({
      type: "error",
      stage: "inference",
      message: `分離の推論に失敗しました: ${errorMessage(e)}`,
    });
  }
}

ctx.addEventListener("message", (event) => {
  const req = event.data;
  if (req.type === "init") {
    void handleInit(req);
  } else if (req.type === "chunk") {
    void handleChunk(req);
  }
});

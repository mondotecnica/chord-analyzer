import type { StemName } from "./config";

export type { StemName };

/** ステレオ音声（分離の入出力単位） */
export interface StereoAudio {
  left: Float32Array;
  right: Float32Array;
  sampleRate: number;
}

/** 分離結果。ステムはメモリ内にのみ存在し、保存しない（MODES.md §4） */
export interface SeparatedStems {
  sampleRate: number;
  stems: Record<StemName, { left: Float32Array; right: Float32Array }>;
}

export type SeparationStage = "model-download" | "separating";

export interface SeparationProgress {
  stage: SeparationStage;
  /** その段階内での進捗 0..1（不明な場合は null） */
  ratio: number | null;
  /** 表示用の補足（例: ダウンロード済み MB） */
  detail?: string;
}

export interface SeparateOptions {
  onProgress?: (p: SeparationProgress) => void;
  /** キャンセル用。abort されたら SeparationCancelledError を投げる */
  signal?: AbortSignal;
}

/**
 * ステム分離器の共通インタフェース。
 * 実装は差し替え可能（現在は ONNX Runtime Web 実装のみ）。
 */
export interface StemSeparator {
  /** 結果メタ情報に記録するモデル識別子（例: "htdemucs"） */
  readonly modelId: string;
  separate(input: StereoAudio, options?: SeparateOptions): Promise<SeparatedStems>;
  /** 実行中なら中断し、リソース（Worker 等）を解放する */
  dispose(): void;
}

/** ユーザー操作によるキャンセル。失敗（エラー）とは区別して扱う */
export class SeparationCancelledError extends Error {
  constructor(message = "分離がキャンセルされました。") {
    super(message);
    this.name = "SeparationCancelledError";
  }
}

/** 分離の失敗。発生段階を保持し、UI のフォールバック判定に使う */
export class SeparationError extends Error {
  readonly stage: "model-download" | "runtime-init" | "inference" | "unsupported";
  constructor(
    stage: SeparationError["stage"],
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "SeparationError";
    this.stage = stage;
  }
}

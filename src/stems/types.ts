import type { StemName } from "./config";
import type { ExecutionProvider } from "./environment";
import type { StoragePersistenceInfo } from "./storagePersistence";

export type { StemName };

/** ステレオ音声（分離の入出力単位） */
export interface StereoAudio {
  left: Float32Array;
  right: Float32Array;
  sampleRate: number;
}

/**
 * 分離の実測時間（待ち時間見積もりの自己キャリブレーション用）。
 * ダウンロードは初回のみで性質が違うため、分離本体とは分けて持つ。
 * 実装が計測しない場合は未設定でよい（任意フィールド）。
 */
export interface SeparationTimings {
  /** モデル取得にかかった秒数（キャッシュ済みならほぼ 0） */
  modelDownloadSeconds: number;
  /** 分離本体（ランタイム初期化 + 推論 + 合成）にかかった秒数 */
  separationSeconds: number;
  /** 実際にセッション生成に使った実行プロバイダ（Worker の ready 応答由来） */
  provider?: ExecutionProvider;
}

/**
 * モデル取得の事実（modelCache の ModelFetchOutcome の分離結果側の形）。
 * 結果表示と書き出しが「ダウンロードだったのか、キャッシュから
 * 読めたのか、保存はできたのか」を正直に伝えるためのもの。
 */
export interface ModelFetchFacts {
  /** 取得元: キャッシュから読めたか、ダウンロードしたか */
  source: "cache" | "download";
  /**
   * ダウンロード後の保存結果。true = 保存できた、false = 失敗した。
   * キャッシュ読み込みの回と保存先が無い場合は null。
   */
  persisted: boolean | null;
  /** 保存したはずのキャッシュが失われていて再取得した場合に true */
  cacheLost: boolean;
}

/** 分離結果。ステムはメモリ内にのみ存在し、保存しない（MODES.md §4） */
export interface SeparatedStems {
  sampleRate: number;
  stems: Record<StemName, { left: Float32Array; right: Float32Array }>;
  /** 実測時間。計測した実装だけが付ける（StemSeparator の任意契約） */
  timings?: SeparationTimings;
  /** モデル取得の事実。計測した実装だけが付ける */
  modelFetch?: ModelFetchFacts;
  /**
   * 永続ストレージ要求と使用量（storagePersistence）。
   * 診断用で、取れなかった項目は null。
   */
  storage?: StoragePersistenceInfo;
}

export type SeparationStage = "model-download" | "separating";

export interface SeparationProgress {
  stage: SeparationStage;
  /** その段階内での進捗 0..1（不明な場合は null） */
  ratio: number | null;
  /** 表示用の補足（例: ダウンロード済み MB） */
  detail?: string;
  /**
   * model-download 段階のみ: キャッシュから読んでいる場合は true。
   * UI が「ダウンロード中」と「読み込み中（キャッシュから）」を
   * 出し分けるために使う（2026-10-28 の実機報告を受けた正直化）。
   */
  fromCache?: boolean;
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

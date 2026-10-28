/** コード解析パイプライン全体で使う共通型定義 */

export interface ChordFrame {
  /** フレーム中心の時刻（秒） */
  time: number;
  /** 推定したコード名。無音・低信頼の場合は "N.C." */
  chord: string;
  /** 0..1 の信頼度 */
  confidence: number;
  /** そのフレームの RMS エネルギー（無音判定用） */
  energy: number;
}

/**
 * Phase 3.1: 二段判定の第2段が付ける拡張音の種類（初期語彙はこの3種のみ）。
 * コードの三和音コア（chord フィールド）とは別フィールドで持つ
 * （bassPc と同じ「別フィールド」方針、DESIGN_NOTES.md）。
 * 表示名（例: "B7"）の組み立ては表示側（lib/chordDisplay.ts）の責務。
 */
export type ChordExtension = "maj7" | "7" | "m7";

export interface ChordSegment {
  id: number;
  start: number; // 秒
  end: number; // 秒
  chord: string;
  /** セグメント内のフレーム信頼度の平均 */
  confidence: number;
  /** ユーザーが手動修正したかどうか */
  edited?: boolean;
  /**
   * Phase 3.1: 7th の拡張音（maj7 / 7 / m7）。二段判定の第2段
   * （analysis/extensionDetection.ts）が証拠のあるセグメントにだけ付ける。
   * 未設定は三和音のまま、という意味（従来の書き出しと互換）。
   */
  extension?: ChordExtension;
  /**
   * Phase 1: 低域から推定したベース音のピッチクラス（0=C .. 11=B）。
   * コードのルートとは別フィールドで持つ（分数コード方針、DESIGN_NOTES.md）。
   * 表示名の組み立て（例: C/E）は UI 側の責務。証拠が乏しいセグメントでは未設定。
   */
  bassPc?: number;
}

/**
 * Phase 3.3: 局所キー推定（analysis/localKey.ts）の窓1件。
 * 曲全体キー（AnalysisResult.keyRoot/keyMode）とは別に、時間で
 * 滑らせた窓ごとのキー候補を持つための型（共有プロファイルへの
 * 加算的な格納。未設定の結果は従来どおり動作する）。
 */
export interface LocalKeyWindow {
  start: number; // 秒
  end: number; // 秒
  /** 窓内の最有力キー */
  root: number; // 0=C .. 11=B
  mode: "major" | "minor";
  /** 最有力キーの Krumhansl プロファイル相関 */
  correlation: number;
  /** 最有力 − 次点（別キー）の相関差。小さいほどキーが曖昧 */
  margin: number;
  /** 次点キーのルート／モード（相関が最有力に近い場合の第二解釈） */
  runnerUpRoot: number;
  runnerUpMode: "major" | "minor";
}

/** 高精度モードのモデル取得の記録（結果表示・書き出し用） */
export interface ModelFetchSummary {
  /** 取得元: キャッシュから読めたか、ダウンロードしたか */
  source: "cache" | "download";
  /** モデル取得にかかった秒数（キャッシュ読み込みの時間を含む） */
  seconds: number;
  /**
   * ダウンロード後の保存結果。true = 保存できた、false = 失敗した。
   * キャッシュ読み込みの回と保存先が無い場合は null。
   */
  persisted: boolean | null;
  /** 保存したはずのキャッシュが失われていて再取得した場合に true */
  cacheLost?: boolean;
  /** ブラウザに永続化が認められたか（診断用。不明な場合は null） */
  storagePersisted?: boolean | null;
  /** ストレージ使用量（バイト、診断用。不明な場合は null） */
  storageUsageBytes?: number | null;
  /** ストレージ上限（バイト、診断用。不明な場合は null） */
  storageQuotaBytes?: number | null;
}

export interface AnalysisResult {
  fileName: string;
  duration: number; // 秒
  sampleRate: number;
  /** 推定キー（例: "C major" / "A minor"）。日本語表示は UI 側で変換 */
  keyName: string;
  keyRoot: number; // 0=C .. 11=B
  keyMode: "major" | "minor";
  /** BPM 推定値（あくまで推定） */
  bpm: number | null;
  segments: ChordSegment[];
  /** 解析にかかったミリ秒 */
  analyzedInMs: number;
  /**
   * 解析モード（MODES.md §6）。未設定は "simple"（簡易モード）として扱う。
   * 簡易モードの解析（analyzeAudio）はこのフィールドを設定しない
   * （従来動作のまま）。高精度モード（analyzeStemsAudio）だけが
   * "high-accuracy" と下記のメタ情報を付ける。
   */
  mode?: "simple" | "high-accuracy";
  /** 高精度モード時の分離モデル名（例: "htdemucs"） */
  separationModel?: string;
  /** 高精度モード時のステム帯域戦略（例: "s-conditional"） */
  stemStrategy?: string;
  /**
   * 高精度モード時のステム分離本体にかかった秒数（モデル取得は含まない）。
   * 分離器が実測した場合のみ設定される。待ち時間の較正と書き出し用。
   */
  separationSeconds?: number;
  /**
   * 高精度モード時のモデル取得の記録（stems 層の ModelFetchFacts に
   * 取得秒数を合わせたもの）。「ダウンロードだったのか、キャッシュ
   * から読めたのか、保存はできたのか」を結果表示と書き出しが
   * 正直に伝えるために持つ。簡易モードでは設定されない。
   */
  modelFetch?: ModelFetchSummary;
  /**
   * Phase 3.3: 局所キー推定の窓列（analysis/localKey.ts）。
   * 2026-10-28 の分割採用以降は既定で設定される加算的フィールド
   * （localKeyRecord: false のオプトアウト時と、消費部 OFF の
   * ハーネス固定時などを除く）。転調の有無や相対調の揺れはこの
   * 窓列に残り、コードラベル自体は変えない
   * （PHASE3_PLAN.md §2: 解釈の判定は出さない）。
   */
  localKeys?: LocalKeyWindow[];
}

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
   * Phase 1: 低域から推定したベース音のピッチクラス（0=C .. 11=B）。
   * コードのルートとは別フィールドで持つ（分数コード方針、DESIGN_NOTES.md）。
   * 表示名の組み立て（例: C/E）は UI 側の責務。証拠が乏しいセグメントでは未設定。
   */
  bassPc?: number;
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
}

/**
 * 高精度モード（ステム分離）の設定集約（MODES.md §2）。
 *
 * モデルの取得先はこのファイルの SEPARATION_MODEL.url が唯一の定義。
 * モデルを差し替える場合はここだけを書き換える。
 */

/**
 * 分離モデル: HTDemucs の ONNX 版（埋め込み型エクスポート）。
 *
 * 取得先は timcsy/demucs-web-onnx（demucs-web プロジェクトが
 * ブラウザ実行用に配布している HTDemucs ONNX）。URL はリビジョン
 * （コミットハッシュ）でピン留めし、再現性を保つ。
 *
 * 実在確認（2026-10-27、この開発環境から HEAD リクエストで確認）:
 * - URL はライブで、リダイレクト先 CDN が 200 を返す
 * - X-Linked-Size / Content-Length = 180,534,758 バイト（≒172MiB、
 *   MODES.md の「約 172MB」と一致）
 * ただしモデル全量のダウンロードと ONNX セッション生成自体は
 * ブラウザ実機でしか検証できていない（MODES.md §8 参照）。
 */
export const SEPARATION_MODEL = {
  /** 結果メタ情報・書き出しに残すモデル識別子 */
  id: "htdemucs",
  /** UI 表示用 */
  displayName: "HTDemucs",
  /** ピン留め済み取得 URL（ここが唯一の定義） */
  url: "https://huggingface.co/timcsy/demucs-web-onnx/resolve/92e33df61cfc9eb820272aaa62d2ef6dcf4d950d/htdemucs_embedded.onnx",
  /** 想定サイズ（バイト）。取得時に照合し、不一致は失敗として扱う */
  expectedBytes: 180_534_758,
  /** Cache Storage のキャッシュ名（モデル更新時はバージョンを上げる） */
  cacheName: "chord-analyzer-models-v1",
} as const;

/** Demucs 系モデルの入出力サンプルレート */
export const SEPARATION_SAMPLE_RATE = 44100;

/**
 * アプリ側チャンク推論のパラメータ（MODES.md §2.3 の初期値）。
 * 曲を 30 秒窓で切り、窓の重なり 2.5 秒をクロスフェードして接続する。
 * 実機検証で確定する設計パラメータであり、確定までは初期値として扱う。
 */
export const CHUNK_SECONDS = 30;
export const CHUNK_OVERLAP_SECONDS = 2.5;

/**
 * モデル内部のセグメント長（サンプル数、44.1kHz で約 7.8 秒）。
 * HTDemucs の学習時のセグメント長であり、この ONNX エクスポートの
 * 入力テンソル形状 [1, 2, 343980] / [1, 4, 2048, 336] に対応する
 * （demucs-web の公開定数 TRAINING_SAMPLES と同一）。
 */
export const MODEL_SEGMENT_SAMPLES = 343_980;
/** モデルセグメント同士の重なり率（demucs の apply_model と同じ 0.25） */
export const MODEL_SEGMENT_OVERLAP_RATIO = 0.25;

/** モデルの入出力に関する定数（HTDemucs の STFT 仕様、demucs-web と同一） */
export const MODEL_FFT_SIZE = 4096;
export const MODEL_HOP_SIZE = 1024;
export const MODEL_SPEC_BINS = 2048;
export const MODEL_SPEC_FRAMES = 336;

/** ステム名（モデル出力の並び順 = Demucs の慣例） */
export const STEM_NAMES = ["drums", "bass", "other", "vocals"] as const;
export type StemName = (typeof STEM_NAMES)[number];

import { formatApproxDuration } from "../stems/separationCalibration";
import type { ModelFetchSummary } from "../types";

/**
 * 高精度モードのモデル取得記録（AnalysisResult.modelFetch）の表示行。
 *
 * 背景: 従来は取得段階の表示が実態と食い違い（キャッシュ読み込みでも
 * 「ダウンロード中（初回のみ）」）、保存失敗も握りつぶされていたため、
 * ユーザーには「毎回ダウンロードしている」ように見えていた
 * （2026-10-28 実機報告）。結果画面では取得の事実を1行で正直に伝える。
 *
 * - キャッシュから読めた回は、その旨と読み込み時間だけを伝える。
 * - ダウンロードして保存できた回は、その旨を伝える。
 * - 保存できなかった回と、前回保存したはずのキャッシュが消えて
 *   いた回は、次回もダウンロードが必要になることを隠さず伝える。
 * 表示専用で、判定や再試行には使わない。
 */
export function modelFetchSummaryLine(
  modelFetch: ModelFetchSummary | undefined,
): string | null {
  if (!modelFetch) return null;
  const duration = formatApproxDuration(modelFetch.seconds);

  if (modelFetch.source === "cache") {
    return `モデル: キャッシュから読み込み（${duration}）`;
  }

  // ダウンロードした回
  if (modelFetch.persisted === false) {
    // 保存できなかった。キャッシュ消失を伴っていても結論は同じ
    // （次回もダウンロードが必要）ため、この行に集約する。
    return "モデルを保存できませんでした（ブラウザの保存容量の制限の可能性があります）。次回もダウンロードが必要になります。";
  }
  if (modelFetch.cacheLost) {
    if (modelFetch.persisted === true) {
      return `モデル: 前回のキャッシュが消えていたため再ダウンロードしました（${duration}）／キャッシュに保存しました`;
    }
    return `モデル: ダウンロード（${duration}）`;
  }
  if (modelFetch.persisted === true) {
    return `モデル: ダウンロード（${duration}）／キャッシュに保存しました`;
  }
  return `モデル: ダウンロード（${duration}）`;
}

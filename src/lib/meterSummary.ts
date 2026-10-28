import type { MeterEstimate } from "../types";

/**
 * 拍子・小節推定（AnalysisResult.meterEstimate）の表示用サマリ。
 *
 * 結果画面とテキスト書き出しで1行に圧縮する表示専用モジュール
 * （lib/localKeySummary.ts と同じ考え方。判定には使わない）。
 *
 * - 確定時: 「3/4 · テンポ 108」。BPM 仲裁で検出値が変わった
 *   場合は「（検出 129）」を併記し、差し替えを透明にする。
 * - 判定保留時: 「判定保留（証拠不足）」。誤った自信のある
 *   拍子を表示しない（meterEstimate.ts の方針）。
 * - 記録が無い場合は null（行自体を出さない）。
 */
export function meterSummaryText(
  meter: MeterEstimate | undefined,
): string | null {
  if (!meter) return null;
  if (meter.beatsPerBar === null || meter.notation === null) {
    return "判定保留（証拠不足）";
  }
  const base = `${meter.notation} · テンポ ${meter.tempoBpm ?? "不明"}`;
  if (
    meter.tempoScale !== 1 &&
    meter.detectedBpm !== null &&
    meter.detectedBpm !== meter.tempoBpm
  ) {
    return `${base}（検出 ${meter.detectedBpm}）`;
  }
  return base;
}

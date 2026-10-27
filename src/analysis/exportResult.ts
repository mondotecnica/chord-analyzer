import { displayChordName } from "../lib/chordDisplay";
import { formatTimePrecise, noteName } from "../lib/notes";
import type { AnalysisResult } from "../types";

/**
 * 解析結果の書き出し。音声データは一切含まない。
 * - JSON: 機械可読。正解データとの比較（正解率測定）に使う想定。
 * - テキスト: 人が読むコード譜形式。
 */

export function resultToJson(result: AnalysisResult): string {
  return JSON.stringify(
    {
      app: "chord-analyzer-phase0",
      version: 1,
      // 解析モード（MODES.md §6）。高精度モードでは分離モデル名と
      // ステム戦略も併記し、後段が入力種別を知る窓口にする
      mode: result.mode ?? "simple",
      ...(result.mode === "high-accuracy"
        ? {
            separationModel: result.separationModel ?? null,
            stemStrategy: result.stemStrategy ?? null,
            // 分離本体の実測秒数（モデル取得は含まない）。実測がある場合のみ
            ...(typeof result.separationSeconds === "number"
              ? { separationSeconds: Number(result.separationSeconds.toFixed(1)) }
              : {}),
          }
        : {}),
      fileName: result.fileName,
      durationSec: Number(result.duration.toFixed(3)),
      key: `${noteName(result.keyRoot)} ${result.keyMode}`,
      bpmEstimate: result.bpm,
      note: "bpm は推定値です。音声データは含まれません。",
      segments: result.segments.map((s) => ({
        startSec: Number(s.start.toFixed(3)),
        endSec: Number(s.end.toFixed(3)),
        chord: s.chord,
        confidence: Number(s.confidence.toFixed(3)),
        edited: Boolean(s.edited),
        // Phase 1: ベース音（ルートとは別フィールド）。推定できた場合のみ含む
        ...(s.bassPc !== undefined ? { bass: noteName(s.bassPc) } : {}),
      })),
    },
    null,
    2,
  );
}

export function resultToText(result: AnalysisResult): string {
  const lines: string[] = [
    `# コード解析結果（Phase 0 試作）`,
    `# ファイル: ${result.fileName}`,
    result.mode === "high-accuracy"
      ? `# モード: 高精度モード（分離モデル: ${result.separationModel ?? "不明"} / ステム戦略: ${result.stemStrategy ?? "不明"}）`
      : `# モード: 簡易モード`,
    `# キー: ${noteName(result.keyRoot)} ${result.keyMode === "major" ? "メジャー" : "マイナー"}`,
    `# 推定BPM: ${result.bpm ?? "不明"}`,
    `# 形式: 開始 - 終了  コード（信頼度）`,
    "",
  ];
  for (const s of result.segments) {
    // テキスト譜では分数コード表示（C/E 等）を使う。JSON 側は
    // chord と bass を別フィールドのまま保持する（resultToJson 参照）。
    lines.push(
      `${formatTimePrecise(s.start)} - ${formatTimePrecise(s.end)}  ${displayChordName(s.chord, s.bassPc)}  (${Math.round(s.confidence * 100)}%)${s.edited ? " [修正済み]" : ""}`,
    );
  }
  return lines.join("\n");
}

export function downloadTextFile(
  filename: string,
  content: string,
  mime: string,
) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function baseName(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, "") || "analysis";
}

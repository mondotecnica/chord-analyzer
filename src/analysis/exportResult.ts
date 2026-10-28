import { displaySegmentChord } from "../lib/chordDisplay";
import { genreSummaryText } from "../lib/genreSummary";
import { summarizeLocalKeys } from "../lib/localKeySummary";
import { meterSummaryText } from "../lib/meterSummary";
import { formatTime, formatTimePrecise, noteName } from "../lib/notes";
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
            // モデル取得の記録（取得元／秒数／保存の成否）。記録がある場合のみ。
            // 「毎回ダウンロードしているのか」を後から切り分けるための診断情報
            ...(result.modelFetch
              ? {
                  modelFetch: {
                    source: result.modelFetch.source,
                    seconds: Number(result.modelFetch.seconds.toFixed(1)),
                    persisted: result.modelFetch.persisted,
                    ...(result.modelFetch.cacheLost
                      ? { cacheLost: true }
                      : {}),
                    ...(typeof result.modelFetch.storagePersisted ===
                    "boolean"
                      ? { storagePersisted: result.modelFetch.storagePersisted }
                      : {}),
                    ...(typeof result.modelFetch.storageUsageBytes ===
                    "number"
                      ? { storageUsageBytes: result.modelFetch.storageUsageBytes }
                      : {}),
                    ...(typeof result.modelFetch.storageQuotaBytes ===
                    "number"
                      ? { storageQuotaBytes: result.modelFetch.storageQuotaBytes }
                      : {}),
                  },
                }
              : {}),
          }
        : {}),
      fileName: result.fileName,
      durationSec: Number(result.duration.toFixed(3)),
      key: `${noteName(result.keyRoot)} ${result.keyMode}`,
      // Phase 3.3: 局所キー窓列（推定した場合のみ。全体キーとは別に、
      // 時間で滑るキー候補とその曖昧さを記録として残す）
      ...(result.localKeys
        ? {
            localKeys: result.localKeys.map((w) => ({
              startSec: Number(w.start.toFixed(3)),
              endSec: Number(w.end.toFixed(3)),
              key: `${noteName(w.root)} ${w.mode}`,
              correlation: Number(w.correlation.toFixed(3)),
              margin: Number(w.margin.toFixed(3)),
              runnerUpKey: `${noteName(w.runnerUpRoot)} ${w.runnerUpMode}`,
            })),
          }
        : {}),
      // Phase 3 後半: 様式プロファイルの推定（推定した場合のみ。
      // 混合比率は特徴空間での様式プロトタイプへの類似度であり、
      // 文化的系譜の比率ではない。特徴量も診断用に残す）
      ...(result.genreProfile
        ? {
            genreProfile: {
              top: result.genreProfile.top,
              confidence: Number(result.genreProfile.confidence.toFixed(3)),
              margin: Number(result.genreProfile.margin.toFixed(3)),
              scores: result.genreProfile.scores.map((s) => ({
                style: s.style,
                score: Number(s.score.toFixed(3)),
              })),
              features: result.genreProfile.features,
            },
          }
        : {}),
      // Phase 3 §5: 拍子・小節推定の記録（推定した場合のみ。
      // 拍子は文脈情報であり、コードラベルの判定には使われていない。
      // detectedBpm は検出器の生値、tempoBpm は仲裁後の候補値。
      // 結果の bpmEstimate がどちらを採用したかは解析時の
      // meterArbitrate オプション（とその既定）による）
      ...(result.meterEstimate
        ? {
            meterEstimate: {
              notation: result.meterEstimate.notation,
              beatsPerBar: result.meterEstimate.beatsPerBar,
              barPhaseSec:
                result.meterEstimate.barPhaseSec !== null
                  ? Number(result.meterEstimate.barPhaseSec.toFixed(3))
                  : null,
              barSec:
                result.meterEstimate.barSec !== null
                  ? Number(result.meterEstimate.barSec.toFixed(3))
                  : null,
              tempoBpm: result.meterEstimate.tempoBpm,
              detectedBpm: result.meterEstimate.detectedBpm,
              tempoScale: result.meterEstimate.tempoScale,
              score: Number(result.meterEstimate.score.toFixed(3)),
              margin: Number(result.meterEstimate.margin.toFixed(3)),
              onsetSource: result.meterEstimate.onsetSource,
              evidence: {
                pulse: Number(result.meterEstimate.evidence.pulse.toFixed(3)),
                barAutocorr: Number(
                  result.meterEstimate.evidence.barAutocorr.toFixed(3),
                ),
                boundary: Number(
                  result.meterEstimate.evidence.boundary.toFixed(3),
                ),
                boundaryAutocorr: Number(
                  result.meterEstimate.evidence.boundaryAutocorr.toFixed(3),
                ),
              },
              runnerUp: result.meterEstimate.runnerUp
                ? {
                    beatsPerBar: result.meterEstimate.runnerUp.beatsPerBar,
                    tempoBpm: result.meterEstimate.runnerUp.tempoBpm,
                    score: Number(result.meterEstimate.runnerUp.score.toFixed(3)),
                  }
                : null,
            },
          }
        : {}),
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
        // Phase 3.1: 拡張音（chord とは別フィールド）。付いた場合のみ含む
        ...(s.extension !== undefined ? { extension: s.extension } : {}),
        // Phase 3.2: 分数コードの上層（chord がベースで潰れた場合の
        // 和声側の読み）と、その 7th・付加音。付いた場合のみ含む
        ...(s.upperChord !== undefined ? { upperChord: s.upperChord } : {}),
        ...(s.upperExtension !== undefined
          ? { upperExtension: s.upperExtension }
          : {}),
        ...(s.addTones !== undefined ? { addTones: [...s.addTones] } : {}),
        // N.C. 回復: 推論で充填した区間の出所。付いた場合のみ含む
        ...(s.ncFill !== undefined ? { ncFill: s.ncFill } : {}),
      })),
    },
    null,
    2,
  );
}

/** 様式プロファイルの要約行（テキスト書き出し用）。記録が無ければ空配列 */
function genreSummaryLines(result: AnalysisResult): string[] {
  const text = genreSummaryText(result.genreProfile);
  return text ? [`# 様式プロファイル: ${text}`] : [];
}

/** 拍子の要約行（テキスト書き出し用）。記録が無ければ空配列 */
function meterSummaryLines(result: AnalysisResult): string[] {
  const text = meterSummaryText(result.meterEstimate);
  return text ? [`# 拍子: ${text}`] : [];
}

/** 局所キーの要約行（テキスト書き出し用）。記録が無ければ空配列 */
function localKeySummaryLines(result: AnalysisResult): string[] {
  const summary = summarizeLocalKeys(result.localKeys);
  if (!summary) return [];
  const label = (root: number, mode: "major" | "minor") =>
    `${noteName(root)} ${mode}`;
  const changes =
    summary.changes.length > 0
      ? `（変化点: ${summary.changes
          .map((c) => `${formatTime(c.atSec)} ${label(c.root, c.mode)}`)
          .join("、")}）`
      : "（目立った変化なし）";
  return [
    `# 局所キー: ${label(summary.dominantRoot, summary.dominantMode)} が中心${changes}`,
  ];
}

export function resultToText(result: AnalysisResult): string {
  const lines: string[] = [
    `# コード解析結果（Phase 0 試作）`,
    `# ファイル: ${result.fileName}`,
    result.mode === "high-accuracy"
      ? `# モード: 高精度モード（分離モデル: ${result.separationModel ?? "不明"} / ステム戦略: ${result.stemStrategy ?? "不明"}）`
      : `# モード: 簡易モード`,
    `# キー: ${noteName(result.keyRoot)} ${result.keyMode === "major" ? "メジャー" : "マイナー"}`,
    // Phase 3.3（分割採用）: 局所キーの要約を1行だけ添える。
    // 窓列の全量は JSON 書き出し側に残る（resultToJson 参照）。
    ...localKeySummaryLines(result),
    // Phase 3 後半: ジャンル傾向の要約も1行だけ添える。
    // 分布と特徴量の全量は JSON 書き出し側に残る。
    ...genreSummaryLines(result),
    // Phase 3 §5: 拍子の要約も1行だけ添える。
    // 証拠の内訳と次点候補の全量は JSON 書き出し側に残る。
    ...meterSummaryLines(result),
    `# 推定BPM: ${result.bpm ?? "不明"}`,
    `# 形式: 開始 - 終了  コード（信頼度）`,
    "",
  ];
  for (const s of result.segments) {
    // テキスト譜では分数コード表示（C/E 等）を使う。JSON 側は
    // chord と bass を別フィールドのまま保持する（resultToJson 参照）。
    lines.push(
      `${formatTimePrecise(s.start)} - ${formatTimePrecise(s.end)}  ${displaySegmentChord(s)}  (${Math.round(s.confidence * 100)}%)${s.edited ? " [修正済み]" : ""}`,
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

import {
  normalizeBarGrid,
  normalizeBarGridSections,
  segmentStartBar,
  type BarGridSettings,
} from "../lib/barGrid";
import { displaySegmentChord } from "../lib/chordDisplay";
import { segmentDegreeInResult } from "../lib/degrees";
import { genreSummaryText } from "../lib/genreSummary";
import { summarizeLocalKeys } from "../lib/localKeySummary";
import { meterSummaryText } from "../lib/meterSummary";
import {
  formatTime,
  formatTimePrecise,
  noteName,
  noteNameSpelled,
  type SpellingFamily,
} from "../lib/notes";
import { capoFretForShift } from "../lib/transpose";
import type { AnalysisResult } from "../types";

/**
 * 解析結果の書き出し。音声データは一切含まない。
 * - JSON: 機械可読。正解データとの比較（正解率測定）に使う想定。
 * - テキスト: 人が読むコード譜形式。
 */

/**
 * 書き出しオプション（移調表示用、lib/transpose.ts）。
 * - spelling: 音名のスペル系。移調済み結果を書き出す場合は移調先
 *   キーの系を渡し、キー名・ベース音名の表記をラベルと揃える。
 * - transposeSemitones: 移調量（半音）。渡された場合、書き出しに
 *   移調の記録（元のキーとの対応）を明示する。元のキーは
 *   result.keyRoot（移調済み）から逆算する。
 * どちらも未指定の場合は従来の書き出しと完全一致する。
 * - barGrid: 小節グリッド設定（lib/barGrid.ts、ユーザー調整値）。
 *   渡された場合、グリッド設定の記録と各セグメントの開始小節番号を
 *   併記する。拍子変更の区間宣言（barGrid.sections）がある場合は
 *   そのリストも記録に含める。小節番号は表示専用の導出値であり、
 *   解析値ではない。未指定の場合は従来の書き出しと完全一致する。
 */
export interface ExportOptions {
  spelling?: SpellingFamily;
  transposeSemitones?: number;
  barGrid?: BarGridSettings;
}

export function resultToJson(
  result: AnalysisResult,
  options: ExportOptions = {},
): string {
  const spelling = options.spelling ?? "sharps";
  const name = (pc: number) => noteNameSpelled(pc, spelling);
  const barGrid = options.barGrid ? normalizeBarGrid(options.barGrid) : null;
  const transposeSemitones = options.transposeSemitones ?? 0;
  const fromKeyRoot =
    ((result.keyRoot - transposeSemitones) % 12 + 12) % 12;
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
      key: `${name(result.keyRoot)} ${result.keyMode}`,
      // 移調表示の書き出しでは、ラベルが移調済みであることと元の
      // キーとの対応を記録する（移調量 0 の書き出しには出ない）
      ...(transposeSemitones !== 0
        ? {
            transpose: {
              semitones: transposeSemitones,
              fromKey: `${noteName(fromKeyRoot)} ${result.keyMode}`,
              toKey: `${name(result.keyRoot)} ${result.keyMode}`,
            },
          }
        : {}),
      // Phase 3.3: 局所キー窓列（推定した場合のみ。全体キーとは別に、
      // 時間で滑るキー候補とその曖昧さを記録として残す）
      ...(result.localKeys
        ? {
            localKeys: result.localKeys.map((w) => ({
              startSec: Number(w.start.toFixed(3)),
              endSec: Number(w.end.toFixed(3)),
              key: `${name(w.root)} ${w.mode}`,
              correlation: Number(w.correlation.toFixed(3)),
              margin: Number(w.margin.toFixed(3)),
              runnerUpKey: `${name(w.runnerUpRoot)} ${w.runnerUpMode}`,
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
      // 小節グリッド（ユーザー設定、lib/barGrid.ts）。渡された場合のみ、
      // 設定そのものを記録し、各セグメントに開始小節番号を併記する。
      // 小節番号は表示専用の導出値であり、解析値ではない
      ...(barGrid
        ? {
            barGrid: {
              bpm: barGrid.bpm,
              beatsPerBar: barGrid.beatsPerBar,
              offsetSec: Number(barGrid.offsetSec.toFixed(3)),
              // 拍子変更の区間宣言。宣言がある場合のみ含める
              // （無い場合は従来の3キーだけの記録と一致させる）。
              // bpm を省略した区間は基準グリッドの bpm 継承を表す
              ...(barGrid.sections && barGrid.sections.length > 0
                ? {
                    sections: barGrid.sections.map((s) => ({
                      startBar: s.startBar,
                      beatsPerBar: s.beatsPerBar,
                      ...(s.bpm !== undefined ? { bpm: s.bpm } : {}),
                    })),
                  }
                : {}),
            },
          }
        : {}),
      note: "bpm は推定値です。音声データは含まれません。",
      segments: result.segments.map((s) => {
        // 度数（機能和声表記、lib/degrees.ts）。表示専用の導出値で、
        // セグメントの局所キー優先で算出する。N.C. では付かない
        const degree = segmentDegreeInResult(s, result);
        // 開始小節番号（lib/barGrid.ts）。グリッド設定がある場合のみ
        const bar = barGrid ? segmentStartBar(s, barGrid) : null;
        return {
        startSec: Number(s.start.toFixed(3)),
        endSec: Number(s.end.toFixed(3)),
        // 開始小節番号。グリッド設定を渡した場合のみ含む
        ...(bar !== null ? { bar } : {}),
        chord: s.chord,
        confidence: Number(s.confidence.toFixed(3)),
        edited: Boolean(s.edited),
        // Phase 1: ベース音（ルートとは別フィールド）。推定できた場合のみ含む
        ...(s.bassPc !== undefined ? { bass: name(s.bassPc) } : {}),
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
        // 度数（機能和声表記）。算出できた場合のみ含む
        ...(degree !== null ? { degree } : {}),
        };
      }),
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
function localKeySummaryLines(
  result: AnalysisResult,
  spelling: SpellingFamily,
): string[] {
  const summary = summarizeLocalKeys(result.localKeys);
  if (!summary) return [];
  const label = (root: number, mode: "major" | "minor") =>
    `${noteNameSpelled(root, spelling)} ${mode}`;
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

/** 移調の記録行（テキスト書き出し用）。移調していなければ空配列 */
function transposeLines(
  result: AnalysisResult,
  options: ExportOptions,
): string[] {
  const semitones = options.transposeSemitones ?? 0;
  if (semitones === 0) return [];
  const fromKeyRoot = ((result.keyRoot - semitones) % 12 + 12) % 12;
  const modeJa = result.keyMode === "major" ? "メジャー" : "マイナー";
  const lines = [
    `# 移調: ${semitones > 0 ? "+" : ""}${semitones} 半音（元のキー: ${noteName(fromKeyRoot)} ${modeJa}）`,
  ];
  const capo = capoFretForShift(semitones);
  if (capo !== null) {
    lines.push(`# カポ: Capo ${capo} で原曲のキーになります`);
  }
  return lines;
}

/** 小節グリッドの記録行（テキスト書き出し用）。設定が無ければ空配列 */
function barGridSummaryLines(options: ExportOptions): string[] {
  if (!options.barGrid) return [];
  const g = normalizeBarGrid(options.barGrid);
  const lines = [
    `# 小節グリッド: ${g.bpm} BPM · ${g.beatsPerBar}/4 · オフセット ${g.offsetSec.toFixed(2)} 秒（ユーザー設定の表示用グリッド。小節番号は解析値ではありません）`,
  ];
  // 拍子変更の区間宣言があれば、宣言ごとに1行ずつ添える
  for (const s of normalizeBarGridSections(g.sections)) {
    lines.push(
      `# 拍子変更: ${s.startBar}小節から ${s.beatsPerBar}/4${s.bpm !== undefined ? ` · ${s.bpm} BPM` : ""}`,
    );
  }
  return lines;
}

export function resultToText(
  result: AnalysisResult,
  options: ExportOptions = {},
): string {
  const spelling = options.spelling ?? "sharps";
  const barGrid = options.barGrid ? normalizeBarGrid(options.barGrid) : null;
  const lines: string[] = [
    `# コード解析結果（Phase 0 試作）`,
    `# ファイル: ${result.fileName}`,
    result.mode === "high-accuracy"
      ? `# モード: 高精度モード（分離モデル: ${result.separationModel ?? "不明"} / ステム戦略: ${result.stemStrategy ?? "不明"}）`
      : `# モード: 簡易モード`,
    `# キー: ${noteNameSpelled(result.keyRoot, spelling)} ${result.keyMode === "major" ? "メジャー" : "マイナー"}`,
    // 移調表示の書き出しでは、移調量と元のキーを明示する。
    ...transposeLines(result, options),
    // Phase 3.3（分割採用）: 局所キーの要約を1行だけ添える。
    // 窓列の全量は JSON 書き出し側に残る（resultToJson 参照）。
    ...localKeySummaryLines(result, spelling),
    // Phase 3 後半: ジャンル傾向の要約も1行だけ添える。
    // 分布と特徴量の全量は JSON 書き出し側に残る。
    ...genreSummaryLines(result),
    // Phase 3 §5: 拍子の要約も1行だけ添える。
    // 証拠の内訳と次点候補の全量は JSON 書き出し側に残る。
    ...meterSummaryLines(result),
    `# 推定BPM: ${result.bpm ?? "不明"}`,
    // 小節グリッド（ユーザー設定）があれば、その記録を1行添える
    ...barGridSummaryLines(options),
    barGrid
      ? `# 形式: 小節  開始 - 終了  コード 度数（信頼度）`
      : `# 形式: 開始 - 終了  コード 度数（信頼度）`,
    "",
  ];
  for (const s of result.segments) {
    // テキスト譜では分数コード表示（C/E 等）を使う。JSON 側は
    // chord と bass を別フィールドのまま保持する（resultToJson 参照）。
    // 度数（lib/degrees.ts）はコードの後ろに併記する。N.C. には付かない。
    // 小節番号（lib/barGrid.ts）はグリッド設定がある場合のみ行頭に付ける。
    const degree = segmentDegreeInResult(s, result);
    const barPrefix = barGrid ? `${segmentStartBar(s, barGrid)}小節  ` : "";
    lines.push(
      `${barPrefix}${formatTimePrecise(s.start)} - ${formatTimePrecise(s.end)}  ${displaySegmentChord(s, spelling)}${degree !== null ? `  ${degree}` : ""}  (${Math.round(s.confidence * 100)}%)${s.edited ? " [修正済み]" : ""}`,
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

/**
 * 実曲測定ハーネス（Phase 1 Step 3 の準備）。
 *
 * 実曲ファイル（WAV / MP3 等）と正解 JSON を受け取り、設定マトリクス
 * （Phase 0 / ベース補正のみ / unified260（旧既定）/ 上帯域220Hz /
 * 現在の既定（分業）/ 分業（明示指定）/ 条件分岐）
 * で同じ曲を A/B 測定する。指標は ACCURACY_MEASUREMENT.md の定義に準拠:
 * - ルート正解率・三和音正解率（時間加重、N.C. 区間は分母から除外し別掲）
 * - 語彙外の正解（Cmaj7 等）は「コア正解」として別枠で数える
 *   （検出のルート＋三和音コアが正解のコアと一致したら正解）
 *
 * 音声デコードはブラウザの decodeAudioData に頼らない:
 * - WAV は既存の readWav16（16bit PCM 以外は ffmpeg にフォールバック）
 * - MP3 / m4a / ogg / flac 等は ffmpeg で 44100Hz モノラルにデコード
 *
 * 実行は npm run measure:real -- --audio <file> --truth <truth.json> [--out <dir>]
 * （scripts/measure-real-launcher.mjs → scripts/measure-real.cli.test.ts 経由）。
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { analyzeAudio, type AnalyzeOptions } from "../src/analysis/analyze";
import { displayChordName } from "../src/lib/chordDisplay";
import { NO_CHORD } from "../src/lib/notes";
import type { AnalysisResult } from "../src/types";
import { parseChord } from "./measureSynthetic";
import { readWav16 } from "./wav";

/** 突き合わせのサンプリング間隔（秒）。既存ハーネスと同一 */
const STEP = 0.01;
const FFMPEG = process.env.FFMPEG_PATH ?? "/usr/bin/ffmpeg";

// ---------------------------------------------------------------------------
// 正解データ（2形式を吸収するアダプタ）
// ---------------------------------------------------------------------------

export interface RealTruthSegment {
  startSec: number;
  endSec: number;
  /** 正解コード名（拡張表記や分数表記を含みうる。例: "Cmaj7", "C/E"） */
  chord: string;
  /** ベース音の音名（ルートと別フィールド。任意） */
  bass?: string;
}

export interface RealTruth {
  title: string;
  key: string | null;
  bpm: number | null;
  durationSec: number;
  segments: RealTruthSegment[];
  sourceFormat: "groundtruth" | "app-export";
}

interface RawSegment {
  startSec?: number;
  endSec?: number;
  chord?: string;
  bass?: string;
  edited?: boolean;
  confidence?: number;
}

interface RawTruth {
  app?: string;
  songId?: string;
  title?: string;
  fileName?: string;
  key?: string;
  bpm?: number;
  bpmEstimate?: number | null;
  durationSec?: number;
  segments?: RawSegment[];
}

/**
 * 正解 JSON を正規化する。受け付ける形式:
 * (a) groundtruth 形式: test-audio/*.groundtruth.json と同じ
 *     { songId?, title?, key?, bpm?, durationSec?, segments: [{startSec, endSec, chord, bass?}] }
 * (b) アプリ書き出し形式: src/analysis/exportResult.ts の JSON
 *     { app, fileName, durationSec, key, bpmEstimate, segments: [{..., edited, confidence}] }
 *     ユーザーが検出結果を手動修正した後の書き出しをそのまま正解として使える。
 */
export function parseTruthJson(raw: unknown, fallbackTitle: string): RealTruth {
  const obj = raw as RawTruth;
  if (!obj || !Array.isArray(obj.segments) || obj.segments.length === 0) {
    throw new Error("正解 JSON に segments がありません");
  }
  const isExport =
    obj.app === "chord-analyzer-phase0" ||
    obj.segments.some((s) => s.edited !== undefined || s.confidence !== undefined);
  const segments: RealTruthSegment[] = obj.segments
    .map((s) => {
      if (
        typeof s.startSec !== "number" ||
        typeof s.endSec !== "number" ||
        typeof s.chord !== "string"
      ) {
        throw new Error("正解セグメントの形式が不正です（startSec/endSec/chord が必要）");
      }
      return {
        startSec: s.startSec,
        endSec: s.endSec,
        chord: s.chord,
        ...(s.bass !== undefined ? { bass: s.bass } : {}),
      };
    })
    .sort((a, b) => a.startSec - b.startSec);
  const lastEnd = Math.max(...segments.map((s) => s.endSec));
  return {
    title: obj.title ?? obj.fileName ?? fallbackTitle,
    key: obj.key ?? null,
    bpm: obj.bpm ?? obj.bpmEstimate ?? null,
    durationSec: obj.durationSec ?? lastEnd,
    segments,
    sourceFormat: isExport ? "app-export" : "groundtruth",
  };
}

// ---------------------------------------------------------------------------
// 正解コード名のパース（拡張コードのコア判定用）
// ---------------------------------------------------------------------------

export interface TruthChordCore {
  root: number;
  /** 三和音コアのモード。sus 等で 3 度が定まらない場合は null（ルートのみで判定） */
  coreMode: "major" | "minor" | null;
  /** Phase 0 の語彙（major/minor 三和音そのもの）かどうか */
  inVocabulary: boolean;
}

const BASE_PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/**
 * 正解コード名を「ルート＋三和音コア」に分解する。
 * 例: "C" → {0, major, inVocab}, "Am" → {9, minor, inVocab},
 *     "Cmaj7" / "C7" / "Cadd9" → {0, major, 語彙外},
 *     "Csus4" → {0, null, 語彙外}（3度がないのでコアはルートのみ）
 *     "C/E" → 分数表記はベースとして分離し、コード部 "C" で判定する。
 *     "B♭" / "Bb" のようなフラット表記もシャープ表記に寄せて受理する。
 */
export function parseTruthChord(chord: string): TruthChordCore | null {
  if (chord === NO_CHORD) return null;
  const main = chord.split("/")[0].replace("♭", "b").replace("♯", "#");
  const m = main.match(/^([A-G])(#|b)?(.*)$/);
  if (!m) return null;
  let root = BASE_PC[m[1]];
  if (m[2] === "#") root += 1;
  if (m[2] === "b") root -= 1;
  root = ((root % 12) + 12) % 12;
  const q = m[3] ?? "";
  if (q === "" || q === "m" || q === "min") {
    return { root, coreMode: q === "" ? "major" : "minor", inVocabulary: true };
  }
  // 語彙外（拡張コード）。三和音コアだけ取り出す
  if (/^sus/.test(q)) return { root, coreMode: null, inVocabulary: false };
  if (/^(dim|°)/.test(q)) return { root, coreMode: "minor", inVocabulary: false };
  if (/^(aug|\+)/.test(q)) return { root, coreMode: "major", inVocabulary: false };
  if (/^m/.test(q) && !/^maj/.test(q)) return { root, coreMode: "minor", inVocabulary: false };
  return { root, coreMode: "major", inVocabulary: false };
}

// ---------------------------------------------------------------------------
// 音声読み込み
// ---------------------------------------------------------------------------

export interface LoadedAudio {
  samples: Float32Array;
  sampleRate: number;
  decodedVia: string;
}

function decodeWithFfmpeg(path: string): LoadedAudio {
  const dir = mkdtempSync(join(tmpdir(), "measure-real-"));
  const rawPath = join(dir, "decoded.f32le");
  try {
    execFileSync(
      FFMPEG,
      ["-v", "error", "-i", path, "-ac", "1", "-ar", "44100", "-f", "f32le", rawPath],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    const buf = readFileSync(rawPath);
    const samples = new Float32Array(Math.floor(buf.length / 4));
    for (let i = 0; i < samples.length; i++) samples[i] = buf.readFloatLE(i * 4);
    return { samples, sampleRate: 44100, decodedVia: "ffmpeg (44100Hz mono)" };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function loadAudioFile(path: string): LoadedAudio {
  if (extname(path).toLowerCase() === ".wav") {
    try {
      const wav = readWav16(path);
      return { samples: wav.samples, sampleRate: wav.sampleRate, decodedVia: "WAV リーダ（16bit PCM）" };
    } catch {
      // 16bit PCM 以外の WAV は ffmpeg にフォールバック
      return decodeWithFfmpeg(path);
    }
  }
  return decodeWithFfmpeg(path);
}

// ---------------------------------------------------------------------------
// 設定マトリクス（A/B）。バリアント追加はこの配列に1行足すだけ
// ---------------------------------------------------------------------------

export interface RealConfig {
  id: string;
  label: string;
  options: AnalyzeOptions;
}

export const REAL_CONFIGS: RealConfig[] = [
  {
    id: "phase0",
    label: "Phase 0（ベース補正なし・全帯域）",
    // 2026-10-27 の既定変更（未指定 = split）で化けないよう戦略も明示固定
    options: { bassCorrection: false, chordBand: null, bandStrategy: "unified" },
  },
  {
    id: "bass",
    label: "ベース補正のみ（全帯域）",
    options: { bassCorrection: true, chordBand: null, bandStrategy: "unified" },
  },
  {
    id: "unified260",
    label: "上帯域 260 一括（旧既定）",
    // 2026-10-27 までの既定。旧 "default" エントリが暗黙に頼っていた
    // 既定値（DEFAULT_CHORD_BAND + unified）を全て明示したもの。
    options: {
      bassCorrection: true,
      chordBand: { cutoffHz: 260, belowWeight: 0 },
      bandStrategy: "unified",
    },
  },
  {
    id: "band220",
    label: "ベース補正＋上帯域 220Hz",
    options: {
      bassCorrection: true,
      chordBand: { cutoffHz: 220, belowWeight: 0 },
      bandStrategy: "unified",
    },
  },
  {
    id: "default",
    label: "現在の既定（分業）",
    // アプリの呼び出しそのまま: 全オプション未指定（{} は未指定と等価で、
    // analyze 側の既定 = ベース補正 ON + bandStrategy "split" +
    // モード判定用帯域 DEFAULT_CHORD_BAND が効く）。2026-10-27 既定化。
    options: {},
  },
  {
    id: "hybrid",
    label: "分業（明示指定）",
    // default と同一の構成を明示指定したもの。既定が将来変わっても
    // 「分業そのもの」を測り続けられるよう、重複を承知で残す。
    // bandStrategy: "split" では chordBand はモード判定用帯域として
    // 解釈される。未指定のため DEFAULT_CHORD_BAND（260Hz）が効く。
    options: { bassCorrection: true, bandStrategy: "split" },
  },
  {
    id: "conditional",
    label: "条件分岐（分業＋崩壊セグメントのみルートも上帯域）",
    // Phase 1.5b: 崩壊シグネチャのあるセグメントだけルートも上帯域で
    // 決め直す（src/analysis/conditionalBand.ts）。それ以外は hybrid と同一。
    options: { bassCorrection: true, bandStrategy: "split-conditional" },
  },
];

// ---------------------------------------------------------------------------
// 測定（ACCURACY_MEASUREMENT.md の指標）
// ---------------------------------------------------------------------------

export interface RealSongMeasurement {
  configId: string;
  detectedKey: string;
  detectedBpm: number | null;
  durationSec: number;
  /** 時間加重・N.C. 除外ベース */
  rootAccuracy: number;
  /** 正解が語彙内の時間だけで計算 */
  triadAccuracy: number;
  triadCountedSec: number;
  /** 正解が語彙外の時間だけで計算する「コア正解率」。対象時間が無ければ null */
  coreAccuracy: number | null;
  coreCountedSec: number;
  ncShare: number;
  lowConfidenceShare: number;
  rootWrongSec: number;
  modeFlipSec: number;
  confusions: { gt: string; det: string; sec: number }[];
  detectedSegments: {
    startSec: number;
    endSec: number;
    chord: string;
    display: string;
    confidence: number;
  }[];
}

export function measureRealSong(
  truth: RealTruth,
  result: AnalysisResult,
  configId: string,
): RealSongMeasurement {
  const total = Math.min(truth.durationSec, result.duration);
  let ncTime = 0;
  let lowConfTime = 0;
  let counted = 0;
  let rootOk = 0;
  let rootWrong = 0;
  let modeFlip = 0;
  let triadCounted = 0;
  let triadOk = 0;
  let coreCounted = 0;
  let coreOk = 0;
  const confusionMap = new Map<string, { gt: string; det: string; sec: number }>();

  let segIdx = 0;
  const segs = result.segments;
  for (let t = 0; t < total; t += STEP) {
    const mid = t + STEP / 2;
    const gtSeg = truth.segments.find((s) => mid >= s.startSec && mid < s.endSec);
    if (!gtSeg) continue;
    while (segIdx < segs.length - 1 && mid >= segs[segIdx].end) segIdx++;
    const det =
      segs[segIdx] && mid >= segs[segIdx].start && mid < segs[segIdx].end
        ? segs[segIdx]
        : null;
    if (!det || det.chord === NO_CHORD) {
      ncTime += STEP;
      continue;
    }
    const gtP = parseTruthChord(gtSeg.chord);
    const detP = parseChord(det.chord);
    if (!gtP || !detP) continue;
    counted += STEP;
    if (det.confidence < 0.55) lowConfTime += STEP;

    const rootMatch = detP.root === gtP.root;
    const modeMatch = gtP.coreMode === null || detP.mode === gtP.coreMode;
    if (rootMatch) rootOk += STEP;
    else rootWrong += STEP;

    let correct: boolean;
    if (gtP.inVocabulary) {
      triadCounted += STEP;
      correct = rootMatch && modeMatch;
      if (correct) triadOk += STEP;
      if (rootMatch && !modeMatch) modeFlip += STEP;
    } else {
      coreCounted += STEP;
      correct = rootMatch && modeMatch;
      if (correct) coreOk += STEP;
      if (rootMatch && !modeMatch) modeFlip += STEP;
    }
    if (!correct) {
      const key = `${gtSeg.chord} → ${det.chord}`;
      const cur = confusionMap.get(key) ?? { gt: gtSeg.chord, det: det.chord, sec: 0 };
      cur.sec += STEP;
      confusionMap.set(key, cur);
    }
  }

  return {
    configId,
    detectedKey: result.keyName,
    detectedBpm: result.bpm,
    durationSec: total,
    rootAccuracy: counted > 0 ? rootOk / counted : 0,
    triadAccuracy: triadCounted > 0 ? triadOk / triadCounted : 0,
    triadCountedSec: triadCounted,
    coreAccuracy: coreCounted > 0 ? coreOk / coreCounted : null,
    coreCountedSec: coreCounted,
    ncShare: total > 0 ? ncTime / total : 0,
    lowConfidenceShare: total > 0 ? lowConfTime / total : 0,
    rootWrongSec: rootWrong,
    modeFlipSec: modeFlip,
    confusions: [...confusionMap.values()].sort((a, b) => b.sec - a.sec).slice(0, 5),
    detectedSegments: segs
      .filter((s) => s.start < total)
      .map((s) => ({
        startSec: Number(s.start.toFixed(2)),
        endSec: Number(Math.min(s.end, total).toFixed(2)),
        chord: s.chord,
        display: displayChordName(s.chord, s.bassPc),
        confidence: Number(s.confidence.toFixed(2)),
      })),
  };
}

// ---------------------------------------------------------------------------
// 実行とレポート
// ---------------------------------------------------------------------------

export interface RealMeasurementRun {
  audioFile: string;
  decodedVia: string;
  sampleRate: number;
  truth: RealTruth;
  configs: { config: RealConfig; measurement: RealSongMeasurement }[];
}

export function songSlug(audioPath: string): string {
  return basename(audioPath, extname(audioPath)).replace(/[^a-zA-Z0-9-_]+/g, "-");
}

const pct = (x: number | null) => (x === null ? "—（対象なし）" : `${(x * 100).toFixed(1)}%`);

export function buildRealReport(run: RealMeasurementRun): string {
  const lines: string[] = [];
  const today = new Date().toISOString().slice(0, 10);
  const t = run.truth;
  lines.push(`# 実曲測定レポート — ${t.title}`);
  lines.push("");
  lines.push(`測定日: ${today} / ハーネス: scripts/measureReal.ts（\`npm run measure:real\`）`);
  lines.push("");
  lines.push(`- 音声: ${run.audioFile}（デコード: ${run.decodedVia}、${run.sampleRate}Hz）`);
  lines.push(`- 正解: ${t.sourceFormat === "app-export" ? "アプリ書き出し（修正済み）" : "groundtruth"} 形式、${t.durationSec.toFixed(1)}秒`);
  if (t.key) lines.push(`- 正解キー: ${t.key}`);
  if (t.bpm) lines.push(`- 正解 BPM: ${t.bpm}`);
  lines.push("");
  lines.push("## 設定別サマリ（時間加重、N.C. は分母から除外）");
  lines.push("");
  lines.push("| 設定 | ルート正解率 | 三和音正解率 | コア正解率（語彙外のみ） | N.C. 割合 | 検出キー | 検出 BPM |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const { config, measurement: m } of run.configs) {
    const keyMark = t.key ? (m.detectedKey === t.key ? " ✓" : " ✗") : "";
    const bpmMark =
      t.bpm && m.detectedBpm !== null
        ? Math.abs(m.detectedBpm - t.bpm) <= 2
          ? " ✓"
          : Math.abs(m.detectedBpm - t.bpm) / t.bpm <= 0.03
            ? "（ほぼ一致）"
            : " ✗"
        : "";
    lines.push(
      `| ${config.id}（${config.label}） | ${pct(m.rootAccuracy)} | ${pct(m.triadAccuracy)} | ${pct(m.coreAccuracy)} | ${pct(m.ncShare)} | ${m.detectedKey}${keyMark} | ${m.detectedBpm ?? "—"}${bpmMark} |`,
    );
  }
  lines.push("");
  lines.push("## 設定別の主な取り違え（正解 → 検出）");
  for (const { config, measurement: m } of run.configs) {
    lines.push("");
    lines.push(`### ${config.id}（${config.label}）`);
    lines.push("");
    if (m.confusions.length === 0) {
      lines.push("取り違えは記録されていない。");
    } else {
      for (const c of m.confusions) lines.push(`- ${c.gt} → ${c.det}: ${c.sec.toFixed(2)}秒`);
    }
    lines.push(
      `- ルート誤り時間: ${m.rootWrongSec.toFixed(2)}秒 / モード誤り（ルート正解）時間: ${m.modeFlipSec.toFixed(2)}秒 / 低信頼区間: ${pct(m.lowConfidenceShare)}`,
    );
  }
  const def = run.configs.find((c) => c.config.id === "default");
  if (def) {
    lines.push("");
    lines.push("## 検出セグメント（default 設定）");
    lines.push("");
    for (const s of def.measurement.detectedSegments) {
      lines.push(`- ${s.startSec.toFixed(2)}–${s.endSec.toFixed(2)}秒: ${s.display}（信頼度 ${s.confidence}）`);
    }
  }
  lines.push("");
  lines.push("## 読み方");
  lines.push("");
  lines.push("- 合成音源の数字（unified でルート 96.9% / 三和音 92.1%、PHASE1_UPPERBAND.md）は最易条件の上限。");
  lines.push("- default は現在のアプリ既定（2026-10-27 から分業）で、全オプション未指定。");
  lines.push("  hybrid は同じ分業の明示指定であり、通常は default と一致する。");
  lines.push("- unified260 は旧既定（ベース補正＋上帯域 260Hz 一括）の明示固定。unified 系が");
  lines.push("  分業系を上回る曲では、帯域一括の方がそのテクスチャに合っているということになる。");
  lines.push("- hybrid（Phase 1.5 分業）は、ルートを bass 設定と同一手順（全帯域＋ベース補正）で");
  lines.push("  決め、モードだけを上帯域 260Hz で決め直す構成（measurements/PHASE1_5_HYBRID.md）。");
  lines.push("- conditional（Phase 1.5b 条件分岐）は hybrid に、崩壊シグネチャのあるセグメント");
  lines.push("  だけルートも上帯域で決め直す分岐を足した構成（measurements/PHASE1_5B_CONDITIONAL.md）。");
  lines.push("- 手順と判断基準の詳細は measurements/REAL_SONG_GUIDE.md を参照。");
  lines.push("");
  return lines.join("\n");
}

export async function runRealMeasurement(args: {
  audioPath: string;
  truthPath: string;
  outDir?: string;
  projectRoot: string;
}): Promise<RealMeasurementRun> {
  const truthRaw = JSON.parse(readFileSync(args.truthPath, "utf-8"));
  const truth = parseTruthJson(truthRaw, basename(args.audioPath));
  // 実曲の正解区間が音声より長い場合は音声長に丸める（測定側の都合であり正解は書き換えない）
  const audio = loadAudioFile(args.audioPath);
  const audioDur = audio.samples.length / audio.sampleRate;
  if (truth.durationSec > audioDur) truth.durationSec = audioDur;

  const configs: RealMeasurementRun["configs"] = [];
  for (const config of REAL_CONFIGS) {
    const result = await analyzeAudio(
      audio.samples,
      audio.sampleRate,
      basename(args.audioPath),
      undefined,
      config.options,
    );
    configs.push({ config, measurement: measureRealSong(truth, result, config.id) });
  }

  const run: RealMeasurementRun = {
    audioFile: basename(args.audioPath),
    decodedVia: audio.decodedVia,
    sampleRate: audio.sampleRate,
    truth,
    configs,
  };

  const outDir =
    args.outDir ?? join(args.projectRoot, "measurements", "real", songSlug(args.audioPath));
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "results.json"), JSON.stringify(run, null, 2) + "\n", "utf-8");
  writeFileSync(join(outDir, "report.md"), buildRealReport(run), "utf-8");
  return run;
}

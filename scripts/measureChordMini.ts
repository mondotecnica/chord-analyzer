/**
 * Phase 4 Stage 1: ChordMini（学習モデル）のアプリ外測定ハーネス。
 *
 * 事前登録は measurements/phase4/CHORDMINI_STAGE1.md §0。ここに書かれた
 * パラメータ（平滑化カーネル 9、断片吸収 2 フレーム、併用の logits 平均等）
 * は実曲の結果を見る前に固定したもので、実曲で調整しない。
 *
 * 推論そのものは scripts/chordmini/run_chordmini.py（librosa CQT +
 * onnxruntime）が tools/chordmini-work/ に logits を書き、本ハーネスは
 * それを読む（キャッシュがあれば再推論しない）。平滑化・argmax・
 * セグメント化はモデルカードのホスト契約に倣い、ここ（TS 側）で行う。
 *
 * 実行: npm run measure:chordmini（vitest 経由）
 * 結果: measurements/phase4/chordmini-results.json
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeAudio } from "../src/analysis/analyze";
import {
  analyzeStemsAudio,
  analyzeStemsWithStrategy,
  prepareStemChromas,
} from "../src/analysis/analyzeStems";
import { NOTE_NAMES, NO_CHORD } from "../src/lib/notes";
import type { AnalysisResult, ChordSegment } from "../src/types";
import {
  loadAudioFile,
  measureRealSong,
  parseTruthChord,
  parseTruthJson,
  type RealSongMeasurement,
  type RealTruth,
} from "./measureReal";
import { shiftTruth } from "./measureHybrid";
import { findStemWav, STEM_SONGS } from "./measureStems";
import { binomialUpperTail } from "./measureEvidenceSelection";
import { SUNO_FIXTURE_WINDOWS, type TruthSeg } from "./measureTheoryStep1";
import { parseChordName } from "../src/analysis/bassCorrection";

const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));
const WORK_DIR = join(PROJECT_ROOT, "tools", "chordmini-work");
const OUT_DIR = join(PROJECT_ROOT, "measurements", "phase4");
const OUT_PATH = join(OUT_DIR, "chordmini-results.json");
const PY = join(PROJECT_ROOT, "tools", "chordmini-venv", "bin", "python");
const RUNNER = join(PROJECT_ROOT, "scripts", "chordmini", "run_chordmini.py");
const MODEL = join(PROJECT_ROOT, "tools", "chordmini", "chordnet.onnx");
const CONFIG = join(PROJECT_ROOT, "tools", "chordmini", "config.json");

/** 事前登録した平滑化カーネル（config.json の smoothingKernel と一致させる） */
export const SMOOTHING_KERNEL = 9;
/** 事前登録した断片吸収の下限（フレーム数。これ未満は長い隣へ吸収） */
export const MIN_SEGMENT_FRAMES = 2;
const STEP = 0.01;

// ---------------------------------------------------------------------------
// 語彙マッピング（§0 の表）
// ---------------------------------------------------------------------------

export type ExtClass =
  | "none" | "maj7" | "dom7" | "min7" | "minmaj7" | "dim7" | "hdim7" | "six" | "sus";

export interface MappedLabel {
  index: number;
  label: string;
  /** N.C. として扱うか（N と X） */
  nc: boolean;
  /** X（unknown）クラスか */
  isX: boolean;
  root: number | null;
  /** 三和音コア。sus は null（root のみ） */
  coreMode: "major" | "minor" | null;
  ext: ExtClass;
}

const QUALITY_MAP: Record<string, { coreMode: "major" | "minor" | null; ext: ExtClass }> = {
  "": { coreMode: "major", ext: "none" },
  min: { coreMode: "minor", ext: "none" },
  dim: { coreMode: "minor", ext: "none" },
  aug: { coreMode: "major", ext: "none" },
  maj6: { coreMode: "major", ext: "six" },
  min6: { coreMode: "minor", ext: "six" },
  maj7: { coreMode: "major", ext: "maj7" },
  "7": { coreMode: "major", ext: "dom7" },
  min7: { coreMode: "minor", ext: "min7" },
  minmaj7: { coreMode: "minor", ext: "minmaj7" },
  dim7: { coreMode: "minor", ext: "dim7" },
  hdim7: { coreMode: "minor", ext: "hdim7" },
  sus2: { coreMode: null, ext: "sus" },
  sus4: { coreMode: null, ext: "sus" },
};

export function mapVocab(vocab: string[]): MappedLabel[] {
  return vocab.map((label, index) => {
    if (label === "N" || label === "X") {
      return { index, label, nc: true, isX: label === "X", root: null, coreMode: null, ext: "none" };
    }
    const [rootName, quality = ""] = label.split(":");
    const root = NOTE_NAMES.indexOf(rootName as (typeof NOTE_NAMES)[number]);
    if (root < 0) throw new Error(`語彙のルートが解釈できない: ${label}`);
    const q = QUALITY_MAP[quality];
    if (!q) throw new Error(`語彙の品質が解釈できない: ${label}`);
    return { index, label, nc: false, isX: false, root, coreMode: q.coreMode, ext: q.ext };
  });
}

const SEVENTH_EXTS: ExtClass[] = ["maj7", "dom7", "min7", "minmaj7", "dim7", "hdim7"];
export const isSeventhExt = (e: ExtClass) => SEVENTH_EXTS.includes(e);

// ---------------------------------------------------------------------------
// logits の取得（Python 推論、キャッシュつき）
// ---------------------------------------------------------------------------

export interface ModelRun {
  key: string;
  frames: number;
  frameDuration: number;
  durationSec: number;
  logits: Float32Array; // [frames, 170]
  vocab: MappedLabel[];
}

function ensureLogits(key: string, audioPath: string): ModelRun {
  const prefix = join(WORK_DIR, key);
  const metaPath = `${prefix}.meta.json`;
  if (!existsSync(metaPath)) {
    execFileSync(
      PY,
      [RUNNER, "--audio", audioPath, "--out", prefix, "--model", MODEL, "--config", CONFIG],
      { stdio: "inherit" },
    );
  }
  const meta = JSON.parse(readFileSync(metaPath, "utf-8")) as {
    frames: number;
    frameDuration: number;
    durationSec: number;
    vocab: string[];
    modelSha256: string;
  };
  const buf = readFileSync(`${prefix}.logits.f32le`);
  const logits = new Float32Array(
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + meta.frames * 170 * 4),
    0,
    meta.frames * 170,
  );
  return {
    key,
    frames: meta.frames,
    frameDuration: meta.frameDuration,
    durationSec: meta.durationSec,
    logits,
    vocab: mapVocab(meta.vocab),
  };
}

/** 2 つの run の logits をフレーム単位で平均した run（併用入力） */
function averageRuns(a: ModelRun, b: ModelRun): ModelRun {
  const frames = Math.min(a.frames, b.frames);
  const logits = new Float32Array(frames * 170);
  for (let i = 0; i < frames * 170; i++) logits[i] = (a.logits[i] + b.logits[i]) / 2;
  return { ...a, key: `${a.key}+${b.key}`, frames, durationSec: frames * a.frameDuration, logits };
}

// ---------------------------------------------------------------------------
// 平滑化 → argmax → セグメント化（事前登録どおり）
// ---------------------------------------------------------------------------

export interface ModelSegment {
  start: number;
  end: number;
  mapped: MappedLabel;
}

export function smoothArgmaxSegments(run: ModelRun): ModelSegment[] {
  const { frames, logits, vocab, frameDuration: fd } = run;
  const C = 170;
  const half = Math.floor(SMOOTHING_KERNEL / 2);
  // 一様移動平均（mode='same'、端はゼロ埋め・割り算は K 固定）→ argmax
  const frameLabel = new Int32Array(frames);
  const acc = new Float64Array(C);
  for (let t = 0; t < frames; t++) {
    acc.fill(0);
    for (let k = -half; k <= half; k++) {
      const src = t + k;
      if (src < 0 || src >= frames) continue;
      const off = src * C;
      for (let c = 0; c < C; c++) acc[c] += logits[off + c];
    }
    let best = 0;
    for (let c = 1; c < C; c++) if (acc[c] > acc[best]) best = c;
    frameLabel[t] = best;
  }
  // ランレングス化
  let runs: { label: number; startFrame: number; endFrame: number }[] = [];
  for (let t = 0; t < frames; t++) {
    const last = runs[runs.length - 1];
    if (last && last.label === frameLabel[t]) last.endFrame = t + 1;
    else runs.push({ label: frameLabel[t], startFrame: t, endFrame: t + 1 });
  }
  // 2 フレーム未満の断片を長い隣へ吸収（繰り返し）
  for (;;) {
    const idx = runs.findIndex((r) => r.endFrame - r.startFrame < MIN_SEGMENT_FRAMES);
    if (idx < 0 || runs.length <= 1) break;
    const prev = runs[idx - 1];
    const next = runs[idx + 1];
    const target =
      prev && next
        ? prev.endFrame - prev.startFrame >= next.endFrame - next.startFrame
          ? prev
          : next
        : (prev ?? next);
    if (!target) break;
    target.startFrame = Math.min(target.startFrame, runs[idx].startFrame);
    target.endFrame = Math.max(target.endFrame, runs[idx].endFrame);
    runs.splice(idx, 1);
    // 隣接した同ラベルの再結合
    const merged: typeof runs = [];
    for (const r of runs) {
      const last = merged[merged.length - 1];
      if (last && last.label === r.label && last.endFrame === r.startFrame) last.endFrame = r.endFrame;
      else merged.push({ ...r });
    }
    runs = merged;
  }
  return runs.map((r) => ({
    start: r.startFrame * fd,
    end: r.endFrame * fd,
    mapped: vocab[r.label],
  }));
}

/** 物差し（measureRealSong）に渡すための AnalysisResult 形 */
export function toAnalysisResult(
  segments: ModelSegment[],
  durationSec: number,
  fileName: string,
): AnalysisResult {
  const segs: ChordSegment[] = segments.map((s, i) => ({
    id: i,
    start: s.start,
    end: s.end,
    chord: s.mapped.nc
      ? NO_CHORD
      : `${NOTE_NAMES[s.mapped.root!]}${s.mapped.coreMode === "minor" ? "m" : ""}`,
    confidence: 1,
  }));
  return {
    fileName,
    duration: durationSec,
    sampleRate: 22050,
    keyName: "—",
    keyRoot: 0,
    keyMode: "major",
    bpm: null,
    segments: segs,
    analyzedInMs: 0,
  } as AnalysisResult;
}

// ---------------------------------------------------------------------------
// 基準5: 拡張の誤発火（標本単位）
// ---------------------------------------------------------------------------

type TruthExt = "plain" | "extended";
export function parseTruthExt(chord: string): TruthExt {
  const main = chord.split("/")[0].replace("♭", "b").replace("♯", "#");
  const m = main.match(/^([A-G])(#|b)?(.*)$/);
  if (!m) return "plain";
  const q = m[3] ?? "";
  return q === "" || q === "m" || q === "min" || q === "dim" || q === "aug" || q === "°" || q === "+"
    ? "plain"
    : "extended";
}

export interface ExtStats {
  /** 正解が plain な時間に 7th 系拡張を出した秒数（誤発火） */
  falseFireSec: number;
  /** 正解が extended で、ルート一致＋7th 系拡張を出した秒数（的中） */
  hitSec: number;
  /** 正解が extended な総秒数 */
  truthExtSec: number;
  /** 正解が plain な総秒数 */
  truthPlainSec: number;
  /** 参考: 6th 系の誤発火秒数（モデルのみ。現行第2段に 6th は無い） */
  sixFalseFireSec: number;
}

interface DetSegExt {
  start: number;
  end: number;
  root: number | null;
  seventh: boolean;
  six: boolean;
}

function extStatsVsTruth(truth: RealTruth, det: DetSegExt[], duration: number): ExtStats {
  const out: ExtStats = { falseFireSec: 0, hitSec: 0, truthExtSec: 0, truthPlainSec: 0, sixFalseFireSec: 0 };
  let di = 0;
  for (let t = 0; t < duration; t += STEP) {
    const mid = t + STEP / 2;
    const gt = truth.segments.find((s) => mid >= s.startSec && mid < s.endSec);
    if (!gt) continue;
    while (di < det.length - 1 && mid >= det[di].end) di++;
    const d = det[di] && mid >= det[di].start && mid < det[di].end ? det[di] : null;
    const gtExt = parseTruthExt(gt.chord);
    const gtRoot = parseTruthChord(gt.chord)?.root ?? null;
    if (gtExt === "extended") {
      out.truthExtSec += STEP;
      if (d?.seventh && d.root !== null && d.root === gtRoot) out.hitSec += STEP;
    } else {
      out.truthPlainSec += STEP;
      if (d?.seventh) out.falseFireSec += STEP;
      if (d?.six) out.sixFalseFireSec += STEP;
    }
  }
  return out;
}

function baselineExtSegs(result: AnalysisResult): DetSegExt[] {
  return result.segments.map((s) => {
    const parsed = s.chord === NO_CHORD ? null : parseChordName(s.chord);
    return {
      start: s.start,
      end: s.end,
      root: parsed?.root ?? null,
      seventh: s.extension !== undefined,
      six: false,
    };
  });
}

function modelExtSegs(segments: ModelSegment[]): DetSegExt[] {
  return segments.map((s) => ({
    start: s.start,
    end: s.end,
    root: s.mapped.root,
    seventh: !s.mapped.nc && isSeventhExt(s.mapped.ext),
    six: !s.mapped.nc && s.mapped.ext === "six",
  }));
}

// ---------------------------------------------------------------------------
// 仲裁診断（EVIDENCE_SELECTION の方法を流用、証人は ChordMini）
// ---------------------------------------------------------------------------

interface TriadKey { root: number; mode: "major" | "minor" }
const sameTriad = (a: TriadKey, b: TriadKey) => a.root === b.root && a.mode === b.mode;

export interface CmArbitrationAcc {
  disagreementSegments: number;
  disagreementSec: number;
  arbitrableSec: number;
  nonArbitrableSec: number;
  aggregate: { correctSec: number; denomSec: number };
  chordmini: { correctSec: number; denomSec: number; abstainSec: number };
  binomial: { segments: number; correct: number };
}

export function newCmArbitrationAcc(): CmArbitrationAcc {
  return {
    disagreementSegments: 0, disagreementSec: 0, arbitrableSec: 0, nonArbitrableSec: 0,
    aggregate: { correctSec: 0, denomSec: 0 },
    chordmini: { correctSec: 0, denomSec: 0, abstainSec: 0 },
    binomial: { segments: 0, correct: 0 },
  };
}

export function addCmArbitration(a: CmArbitrationAcc, b: CmArbitrationAcc) {
  a.disagreementSegments += b.disagreementSegments;
  a.disagreementSec += b.disagreementSec;
  a.arbitrableSec += b.arbitrableSec;
  a.nonArbitrableSec += b.nonArbitrableSec;
  a.aggregate.correctSec += b.aggregate.correctSec;
  a.aggregate.denomSec += b.aggregate.denomSec;
  a.chordmini.correctSec += b.chordmini.correctSec;
  a.chordmini.denomSec += b.chordmini.denomSec;
  a.chordmini.abstainSec += b.chordmini.abstainSec;
  a.binomial.segments += b.binomial.segments;
  a.binomial.correct += b.binomial.correct;
}

function arbitrationVsTruth(
  truth: TruthSeg[],
  result: AnalysisResult,
  modelSegs: ModelSegment[],
): CmArbitrationAcc {
  const acc = newCmArbitrationAcc();
  const segs = result.segments;
  for (const seg of segs) {
    const cands = seg.candidates;
    if (!cands || cands.length === 0) continue;
    const winner: TriadKey = { root: cands[0].root, mode: cands[0].mode };
    let argmax = cands[0];
    for (const c of cands) if (c.score > argmax.score) argmax = c;
    const argmaxKey: TriadKey = { root: argmax.root, mode: argmax.mode };
    if (sameTriad(winner, argmaxKey)) continue;
    acc.disagreementSegments++;
    acc.disagreementSec += seg.end - seg.start;

    // ChordMini の票: セグメント内フレームの支持時間（root 一致＋
    // コア一致またはコア不定）を両側で比べる
    let winnerSupport = 0;
    let argmaxSupport = 0;
    for (const ms of modelSegs) {
      const lo = Math.max(ms.start, seg.start);
      const hi = Math.min(ms.end, seg.end);
      if (hi <= lo || ms.mapped.nc) continue;
      const dur = hi - lo;
      const m = ms.mapped;
      if (m.root === winner.root && (m.coreMode === null || m.coreMode === winner.mode)) winnerSupport += dur;
      if (m.root === argmaxKey.root && (m.coreMode === null || m.coreMode === argmaxKey.mode)) argmaxSupport += dur;
    }
    const pick: TriadKey | null =
      winnerSupport > argmaxSupport ? winner : argmaxSupport > winnerSupport ? argmaxKey : null;

    let winnerTruthSec = 0;
    let argmaxTruthSec = 0;
    const ASTEP = 0.05;
    for (let t = seg.start; t < seg.end; t += ASTEP) {
      const mid = t + ASTEP / 2;
      if (mid >= seg.end) break;
      const gt = truth.find((g) => mid >= g.start && mid < g.end);
      if (!gt || gt.coreMode === null) continue;
      const gtKey: TriadKey = { root: gt.root, mode: gt.coreMode };
      const wMatch = sameTriad(gtKey, winner);
      const aMatch = sameTriad(gtKey, argmaxKey);
      if (wMatch && !aMatch) winnerTruthSec += ASTEP;
      else if (aMatch && !wMatch) argmaxTruthSec += ASTEP;
      else acc.nonArbitrableSec += ASTEP;
    }
    const arbitrable = winnerTruthSec + argmaxTruthSec;
    if (arbitrable <= 0) continue;
    acc.arbitrableSec += arbitrable;
    acc.aggregate.denomSec += arbitrable;
    acc.aggregate.correctSec += argmaxTruthSec;
    if (!pick) {
      acc.chordmini.abstainSec += arbitrable;
    } else {
      acc.chordmini.denomSec += arbitrable;
      acc.chordmini.correctSec += sameTriad(pick, winner) ? winnerTruthSec : argmaxTruthSec;
    }
    if (arbitrable >= 0.2 && winnerTruthSec !== argmaxTruthSec && pick) {
      const truthSide = winnerTruthSec > argmaxTruthSec ? winner : argmaxKey;
      acc.binomial.segments++;
      if (sameTriad(pick, truthSide)) acc.binomial.correct++;
    }
  }
  return acc;
}

export function cmArbitrationReport(acc: CmArbitrationAcc) {
  return {
    disagreementSegments: acc.disagreementSegments,
    disagreementSec: acc.disagreementSec,
    arbitrableSec: acc.arbitrableSec,
    nonArbitrableSec: acc.nonArbitrableSec,
    aggregateAccuracy: acc.aggregate.denomSec > 0 ? acc.aggregate.correctSec / acc.aggregate.denomSec : 0,
    winnerBaselineAccuracy: acc.aggregate.denomSec > 0 ? 1 - acc.aggregate.correctSec / acc.aggregate.denomSec : 0,
    chordminiAccuracy: acc.chordmini.denomSec > 0 ? acc.chordmini.correctSec / acc.chordmini.denomSec : 0,
    chordminiDenomSec: acc.chordmini.denomSec,
    chordminiAbstainSec: acc.chordmini.abstainSec,
    binomial: {
      segments: acc.binomial.segments,
      correct: acc.binomial.correct,
      accuracy: acc.binomial.segments > 0 ? acc.binomial.correct / acc.binomial.segments : 0,
      pValue: binomialUpperTail(acc.binomial.correct, acc.binomial.segments),
    },
  };
}

// ---------------------------------------------------------------------------
// Suno フィクスチャ
// ---------------------------------------------------------------------------

export interface WindowLabelStat {
  /** ラベル → 時間（秒） */
  byLabel: Record<string, number>;
  totalSec: number;
  /** 過半ラベルとその割合 */
  majority: { label: string; share: number } | null;
}

export function windowLabelStats(segments: ModelSegment[], lo: number, hi: number): WindowLabelStat {
  const byLabel: Record<string, number> = {};
  let total = 0;
  for (const s of segments) {
    const a = Math.max(s.start, lo);
    const b = Math.min(s.end, hi);
    if (b <= a) continue;
    byLabel[s.mapped.label] = (byLabel[s.mapped.label] ?? 0) + (b - a);
    total += b - a;
  }
  let majority: WindowLabelStat["majority"] = null;
  for (const [label, sec] of Object.entries(byLabel)) {
    if (!majority || sec / total > majority.share) majority = { label, share: total > 0 ? sec / total : 0 };
  }
  return { byLabel, totalSec: total, majority };
}

/** 窓内で (root, coreMode) に一致する時間の割合。coreMode null の正解は root のみ */
export function windowTriadShare(
  segments: ModelSegment[],
  lo: number,
  hi: number,
  root: number,
  coreMode: "major" | "minor" | null,
): number {
  let ok = 0;
  let total = 0;
  for (const s of segments) {
    const a = Math.max(s.start, lo);
    const b = Math.min(s.end, hi);
    if (b <= a) continue;
    total += b - a;
    if (!s.mapped.nc && s.mapped.root === root && (coreMode === null || s.mapped.coreMode === coreMode || s.mapped.coreMode === null)) {
      ok += b - a;
    }
  }
  return total > 0 ? ok / total : 0;
}

const C_MINOR_CORE_QUALITIES = ["min", "min6", "min7", "minmaj7", "dim", "dim7", "hdim7"];
export function windowCMinorBreakdown(segments: ModelSegment[], lo: number, hi: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of segments) {
    const a = Math.max(s.start, lo);
    const b = Math.min(s.end, hi);
    if (b <= a || s.mapped.nc || s.mapped.root !== 0) continue;
    const quality = s.mapped.label.split(":")[1] ?? "";
    if (C_MINOR_CORE_QUALITIES.includes(quality)) out[s.mapped.label] = (out[s.mapped.label] ?? 0) + (b - a);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 実行
// ---------------------------------------------------------------------------

export interface ChordMiniResults {
  generatedAt: string;
  model: { sha256: string; revision: string; vocabSize: number };
  config: { smoothingKernel: number; minSegmentFrames: number };
  real: {
    slug: string;
    title: string;
    baselines: { defaultMix: RealSongMeasurement; defaultMixExt: RealSongMeasurement; stemsCurrent: RealSongMeasurement; stemsCurrentExt: RealSongMeasurement };
    chordmini: Record<"mixture" | "other" | "combined", RealSongMeasurement>;
    ext: Record<string, ExtStats>;
    ncShare: Record<string, number>;
    xShare: Record<string, number>;
    susShare: Record<string, number>;
    sensitivity: { shiftSec: number; scores: Record<string, number> }[];
  }[];
  arbitration: {
    perSong: { slug: string; path: string; report: ReturnType<typeof cmArbitrationReport> }[];
    perPath: Record<string, ReturnType<typeof cmArbitrationReport>>;
    pooled: ReturnType<typeof cmArbitrationReport>;
  };
  suno05: {
    inputs: Record<string, {
      ncShare: number;
      xShare: number;
      segments: { start: number; end: number; label: string }[];
      windows: Record<string, WindowLabelStat & { settledShare: number | null }>;
      q3SubWindows: Record<string, WindowLabelStat & { triadShare: number; dom7Share: number }>;
      q2CMinor: Record<string, number>;
    }>;
  };
}

const songScore = (m: RealSongMeasurement) =>
  (m.rootAccuracy + m.triadAccuracy + (m.coreAccuracy ?? 0)) / 3;

function realTruthSegs(path: string): TruthSeg[] {
  const truth = parseTruthJson(JSON.parse(readFileSync(path, "utf-8")), path);
  return truth.segments.flatMap((s) => {
    const p = parseTruthChord(s.chord);
    return p ? [{ start: s.startSec, end: s.endSec, root: p.root, coreMode: p.coreMode }] : [];
  });
}

export async function runChordMiniMeasurement(): Promise<ChordMiniResults> {
  mkdirSync(WORK_DIR, { recursive: true });
  const results: ChordMiniResults = {
    generatedAt: new Date().toISOString(),
    model: { sha256: "", revision: "8ab85fc0f61439900cd07ac21257a43eac57075c", vocabSize: 170 },
    config: { smoothingKernel: SMOOTHING_KERNEL, minSegmentFrames: MIN_SEGMENT_FRAMES },
    real: [],
    arbitration: { perSong: [], perPath: {}, pooled: cmArbitrationReport(newCmArbitrationAcc()) },
    suno05: { inputs: {} },
  };
  const arbPooled: Record<string, CmArbitrationAcc> = { mixture: newCmArbitrationAcc(), stems: newCmArbitrationAcc() };
  const arbTotal = newCmArbitrationAcc();

  const specs = STEM_SONGS.filter((s) => s.slug !== "song-d");

  for (const spec of specs) {
    const truthRaw: RealTruth = parseTruthJson(JSON.parse(readFileSync(spec.truthPath, "utf-8")), spec.slug);
    const truthSegs = realTruthSegs(spec.truthPath);
    const mix = loadAudioFile(spec.mixPath);
    const otherPath = findStemWav(spec.stemRoot, "other");
    const bassPath = findStemWav(spec.stemRoot, "bass");
    if (!otherPath || !bassPath) continue;
    const other = loadAudioFile(otherPath);
    const bass = loadAudioFile(bassPath);
    const duration = Math.min(truthRaw.durationSec, mix.samples.length / mix.sampleRate);
    const truth: RealTruth = { ...truthRaw, durationSec: duration };

    // --- 現行既定ベースライン（同じ実行で再測定） ---
    const defMix = await analyzeAudio(mix.samples, mix.sampleRate, spec.slug);
    const defMixExt = await analyzeAudio(mix.samples, mix.sampleRate, spec.slug, undefined, { extensions: true });
    const stemInput = {
      mixSamples: mix.samples, otherSamples: other.samples, bassSamples: bass.samples,
      sampleRate: mix.sampleRate, fileName: spec.slug,
    };
    const stemsCur = await analyzeStemsAudio(stemInput);
    const stemsCurExt = await analyzeStemsAudio(stemInput, undefined, { extensions: true });

    // --- ChordMini 3 入力 ---
    const runMix = ensureLogits(`${spec.slug}-mix`, spec.mixPath);
    const runOther = ensureLogits(`${spec.slug}-other`, otherPath);
    const runComb = averageRuns(runMix, runOther);
    results.model.sha256 = JSON.parse(readFileSync(join(WORK_DIR, `${spec.slug}-mix.meta.json`), "utf-8")).modelSha256;
    const cmSegs: Record<string, ModelSegment[]> = {
      mixture: smoothArgmaxSegments(runMix),
      other: smoothArgmaxSegments(runOther),
      combined: smoothArgmaxSegments(runComb),
    };
    const cmMeas: Record<string, RealSongMeasurement> = {};
    for (const [id, segs] of Object.entries(cmSegs)) {
      cmMeas[id] = measureRealSong(truth, toAnalysisResult(segs, runMix.durationSec, spec.slug), `chordmini-${id}`);
    }

    // --- 基準5: 拡張 ---
    const ext: Record<string, ExtStats> = {
      "baseline-mix-ext": extStatsVsTruth(truth, baselineExtSegs(defMixExt), duration),
      "baseline-stems-ext": extStatsVsTruth(truth, baselineExtSegs(stemsCurExt), duration),
      "chordmini-mixture": extStatsVsTruth(truth, modelExtSegs(cmSegs.mixture), duration),
      "chordmini-other": extStatsVsTruth(truth, modelExtSegs(cmSegs.other), duration),
      "chordmini-combined": extStatsVsTruth(truth, modelExtSegs(cmSegs.combined), duration),
    };

    // --- N.C. / X / sus 割合 ---
    const shareOf = (segs: ModelSegment[], pred: (m: MappedLabel) => boolean) => {
      let n = 0;
      let tot = 0;
      for (const s of segs) {
        tot += s.end - s.start;
        if (pred(s.mapped)) n += s.end - s.start;
      }
      return tot > 0 ? n / tot : 0;
    };
    const ncShare: Record<string, number> = {};
    const xShare: Record<string, number> = {};
    const susShare: Record<string, number> = {};
    for (const [id, segs] of Object.entries(cmSegs)) {
      ncShare[id] = shareOf(segs, (m) => m.nc);
      xShare[id] = shareOf(segs, (m) => m.isX);
      susShare[id] = shareOf(segs, (m) => !m.nc && m.coreMode === null);
    }
    ncShare["baseline-mix"] = measureRealSong(truth, defMix, "default").ncShare;
    ncShare["baseline-stems"] = measureRealSong(truth, stemsCur, "stems").ncShare;

    // --- 基準6: 感度（順位） ---
    const systemsAt = (shift: number) => {
      const t2 = shiftTruth(truth, shift);
      const scores: Record<string, number> = {
        "default-mix": songScore(measureRealSong(t2, defMix, "default")),
        "stems-current": songScore(measureRealSong(t2, stemsCur, "stems")),
        "chordmini-mixture": songScore(measureRealSong(t2, toAnalysisResult(cmSegs.mixture, runMix.durationSec, spec.slug), "cm")),
        "chordmini-other": songScore(measureRealSong(t2, toAnalysisResult(cmSegs.other, runMix.durationSec, spec.slug), "cm")),
        "chordmini-combined": songScore(measureRealSong(t2, toAnalysisResult(cmSegs.combined, runMix.durationSec, spec.slug), "cm")),
      };
      return scores;
    };
    const sensitivity = [-0.3, 0, 0.3].map((shiftSec) => ({ shiftSec, scores: systemsAt(shiftSec) }));

    results.real.push({
      slug: spec.slug,
      title: spec.title,
      baselines: {
        defaultMix: measureRealSong(truth, defMix, "default"),
        defaultMixExt: measureRealSong(truth, defMixExt, "default-ext"),
        stemsCurrent: measureRealSong(truth, stemsCur, "stems"),
        stemsCurrentExt: measureRealSong(truth, stemsCurExt, "stems-ext"),
      },
      chordmini: {
        mixture: cmMeas.mixture,
        other: cmMeas.other,
        combined: cmMeas.combined,
      },
      ext,
      ncShare,
      xShare,
      susShare,
      sensitivity,
    });

    // --- 仲裁診断 ---
    {
      const mixCand = await analyzeAudio(mix.samples, mix.sampleRate, spec.slug, undefined, { candidateRecord: true });
      const arbMix = arbitrationVsTruth(truthSegs, mixCand, cmSegs.mixture);
      addCmArbitration(arbPooled.mixture, arbMix);
      addCmArbitration(arbTotal, arbMix);
      results.arbitration.perSong.push({ slug: spec.slug, path: "mixture", report: cmArbitrationReport(arbMix) });
    }
    {
      const chromas = prepareStemChromas(mix.samples, other.samples, bass.samples, mix.sampleRate);
      const stemsCand = analyzeStemsWithStrategy(chromas, chromas.sampleRate, spec.slug, "s-conditional", { candidateRecord: true });
      const arbStems = arbitrationVsTruth(truthSegs, stemsCand, cmSegs.other);
      addCmArbitration(arbPooled.stems, arbStems);
      addCmArbitration(arbTotal, arbStems);
      results.arbitration.perSong.push({ slug: spec.slug, path: "stems", report: cmArbitrationReport(arbStems) });
    }
  }
  results.arbitration.perPath = {
    mixture: cmArbitrationReport(arbPooled.mixture),
    stems: cmArbitrationReport(arbPooled.stems),
  };
  results.arbitration.pooled = cmArbitrationReport(arbTotal);

  // --- Suno 05 フィクスチャ ---
  const mix05Path = join(homedir(), "workspace/user/files/05.mp3");
  const other05Path = findStemWav(join(PROJECT_ROOT, "stem-work/suno-05"), "other");
  const sunoRuns: Record<string, ModelRun> = {
    mixture: ensureLogits("suno05-mix", mix05Path),
    ...(other05Path ? { other: ensureLogits("suno05-other", other05Path) } : {}),
  };
  const Q3_SUB: Record<string, { range: [number, number]; root: number; mode: "major" | "minor"; dom7: boolean }> = {
    "Q3-C (85-87)": { range: [85, 87], root: 0, mode: "major", dom7: false },
    "Q3-B7 (87-89)": { range: [87, 89], root: 11, mode: "major", dom7: true },
    "Q3-E7 (89-91)": { range: [89, 91], root: 4, mode: "major", dom7: true },
    "Q3-Am (91-93)": { range: [91, 93], root: 9, mode: "minor", dom7: false },
  };
  for (const [inputId, run] of Object.entries(sunoRuns)) {
    const segs = smoothArgmaxSegments(run);
    const windows: ChordMiniResults["suno05"]["inputs"][string]["windows"] = {};
    for (const win of SUNO_FIXTURE_WINDOWS) {
      const [lo, hi] = win.range;
      const stat = windowLabelStats(segs, lo, hi);
      windows[win.name] = {
        ...stat,
        settledShare: win.settled ? windowTriadShare(segs, lo, hi, win.settled.root, win.settled.mode) : null,
      };
    }
    const q3: ChordMiniResults["suno05"]["inputs"][string]["q3SubWindows"] = {};
    for (const [name, sub] of Object.entries(Q3_SUB)) {
      const [lo, hi] = sub.range;
      const stat = windowLabelStats(segs, lo, hi);
      let dom7Sec = 0;
      for (const s of segs) {
        const a = Math.max(s.start, lo);
        const b = Math.min(s.end, hi);
        if (b > a && !s.mapped.nc && s.mapped.root === sub.root && s.mapped.ext === "dom7") dom7Sec += b - a;
      }
      q3[name] = {
        ...stat,
        triadShare: windowTriadShare(segs, lo, hi, sub.root, sub.mode),
        dom7Share: stat.totalSec > 0 ? dom7Sec / stat.totalSec : 0,
      };
    }
    let ncSec = 0;
    let xSec = 0;
    let tot = 0;
    for (const s of segs) {
      tot += s.end - s.start;
      if (s.mapped.nc) ncSec += s.end - s.start;
      if (s.mapped.isX) xSec += s.end - s.start;
    }
    results.suno05.inputs[inputId] = {
      ncShare: tot > 0 ? ncSec / tot : 0,
      xShare: tot > 0 ? xSec / tot : 0,
      segments: segs.map((s) => ({ start: Number(s.start.toFixed(2)), end: Number(s.end.toFixed(2)), label: s.mapped.label })),
      windows,
      q3SubWindows: q3,
      q2CMinor: windowCMinorBreakdown(segs, 153, 168),
    };
  }

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_PATH, `${JSON.stringify(results, null, 2)}\n`);
  return results;
}

/**
 * N.C.（無判定）改善ラウンドの測定ハーネス。
 *
 * 構成は「診断 → 介入」の2段:
 * - runNcAnatomy: 既定パイプラインの N.C. セグメントを原因別に分類する
 *   （scripts/ncAnatomy.ts）。生成物: measurements/nc/nc-anatomy.json
 * - runNcRecovery: 介入（src/analysis/ncRecovery.ts、フラグ ON）と
 *   ベースライン（既定）を全スイートで A/B し、N.C. 秒の「正解への変換 /
 *   誤りへの変換 / 据え置き」を数える。生成物: measurements/nc/nc-recovery.json
 *
 * スイート構成（従来ハーネスと同一の素材・同一の既定経路）:
 * - 合成 A–I（混合音・アプリ既定 = split）
 * - 実曲 1–3（混合音・既定 / ステム s-conditional）＋ Song D ステム
 * - Suno 05（混合音・既定 / ステム s-conditional、正解なし。
 *   Q1–Q4 フィクスチャは measurePhase3 の evaluateSunoFixtures で照合）
 *
 * 介入の採否基準は measurements/nc/NC_ANALYSIS.md に事前登録してある。
 * 本ハーネスは数値を出すだけで、判定は文書側で行う。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  analyzeAudio as analyzeAudioImpl,
  DEFAULT_CHORD_BAND,
} from "../src/analysis/analyze";
import {
  analyzeStemsWithStrategy as analyzeStemsWithStrategyImpl,
  prepareStemChromas,
  type StemChromas,
} from "../src/analysis/analyzeStems";
import { computeChromagram } from "../src/dsp/chroma";
import { NO_CHORD } from "../src/lib/notes";
import type { AnalysisResult, ChordSegment } from "../src/types";
import {
  loadAudioFile,
  measureRealSong,
  parseTruthChord,
  parseTruthJson,
  type RealTruth,
} from "./measureReal";
import { findStemWav, STEM_SONGS } from "./measureStems";
import { measureSong, parseChord } from "./measureSynthetic";
import { evaluateSunoFixtures, type SunoFixtureResult } from "./measurePhase3";
import {
  classifyNcSegments,
  frameEvidence,
  summarizeNcRecords,
  type ChromaEvidenceSource,
  type NcCauseTotals,
  type NcSegmentRecord,
  type NcTruthSpan,
} from "./ncAnatomy";
import {
  ADD9_SONGS,
  BLUES_SONGS,
  ROCK_SONGS,
  SECONDARY_DOMINANT_SONGS,
  SEVENTH_SONGS,
  SLASH_SONGS,
  SONGS,
  synthSong,
  type GroundTruth,
  type SongSpec,
} from "./synth";
import { readWav16, writeWav16 } from "./wav";

const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));
const TEST_AUDIO_DIR = join(PROJECT_ROOT, "test-audio");
const NC_DIR = join(PROJECT_ROOT, "measurements", "nc");
const SAMPLE_RATE = 44100;

// 本ハーネスは legacy ゲートのパイプラインを対象とする（NC_ANALYSIS.md
// の診断・介入は旧ゲートについての測定）。アプリ既定が曲参照ゲート
// （FRAME_GATE.md で採用）に変わった後も記録を再現できるよう、
// 全呼び出しで frameGate: "legacy" を固定する。
const analyzeAudio: typeof analyzeAudioImpl = (
  samples,
  sampleRate,
  fileName,
  onProgress,
  options,
) =>
  analyzeAudioImpl(samples, sampleRate, fileName, onProgress, {
    frameGate: "legacy",
    ...options,
  });
const analyzeStemsWithStrategy: typeof analyzeStemsWithStrategyImpl = (
  chromas,
  sampleRate,
  fileName,
  strategy,
  opts,
) =>
  analyzeStemsWithStrategyImpl(chromas, sampleRate, fileName, strategy, {
    frameGate: "legacy",
    ...opts,
  });

const SYNTH_SPECS: SongSpec[] = [
  ...SONGS,
  ...SLASH_SONGS,
  ...SEVENTH_SONGS,
  ...SECONDARY_DOMINANT_SONGS,
  ...ADD9_SONGS,
  ...BLUES_SONGS,
  ...ROCK_SONGS,
];
const REAL_SLUGS = ["put-your-records-on", "everything", "a-hard-days-night"];

function outDir(): string {
  mkdirSync(NC_DIR, { recursive: true });
  return NC_DIR;
}

function writeJson(name: string, data: unknown): void {
  writeFileSync(join(outDir(), name), JSON.stringify(data, null, 2) + "\n", "utf-8");
}

function ncShareOf(result: AnalysisResult): number {
  let nc = 0;
  for (const s of result.segments) {
    if (s.chord === NO_CHORD) nc += s.end - s.start;
  }
  return result.duration > 0 ? nc / result.duration : 0;
}

function sourceOf(chroma: ReturnType<typeof computeChromagram>): ChromaEvidenceSource {
  return {
    frames: chroma.frames,
    energies: chroma.energies,
    frameDuration: chroma.frameDuration,
  };
}

// ---------------------------------------------------------------------------
// 解剖（診断）
// ---------------------------------------------------------------------------

export interface NcSongAnatomy {
  suite: "synthetic" | "real-mixture" | "real-stems" | "suno-mixture" | "suno-stems";
  id: string;
  title: string;
  durationSec: number;
  ncShare: number;
  totals: NcCauseTotals;
  records: NcSegmentRecord[];
}

interface LoadedReal {
  slug: string;
  title: string;
  truth: RealTruth;
  mixSamples: Float32Array;
  sampleRate: number;
  chromas?: StemChromas;
  otherSamples?: Float32Array;
  bassSamples?: Float32Array;
}

function loadReal(slug: string, withStems: boolean): LoadedReal | null {
  const spec = STEM_SONGS.find((s) => s.slug === slug)!;
  if (!existsSync(spec.mixPath) || !existsSync(spec.truthPath)) return null;
  const truth = parseTruthJson(
    JSON.parse(readFileSync(spec.truthPath, "utf-8")),
    slug,
  );
  const mix = loadAudioFile(spec.mixPath);
  const audioDur = mix.samples.length / mix.sampleRate;
  if (truth.durationSec > audioDur) truth.durationSec = audioDur;
  const loaded: LoadedReal = {
    slug,
    title: spec.title,
    truth,
    mixSamples: mix.samples,
    sampleRate: mix.sampleRate,
  };
  if (withStems) {
    const otherPath = findStemWav(spec.stemRoot, "other");
    const bassPath = findStemWav(spec.stemRoot, "bass");
    if (!otherPath || !bassPath) return null;
    const other = loadAudioFile(otherPath);
    const bass = loadAudioFile(bassPath);
    loaded.otherSamples = other.samples;
    loaded.bassSamples = bass.samples;
    loaded.chromas = prepareStemChromas(
      mix.samples,
      other.samples,
      bass.samples,
      mix.sampleRate,
    );
  }
  return loaded;
}

function truthSpans(truth: RealTruth | GroundTruth): NcTruthSpan[] {
  return truth.segments.map((s) => ({
    startSec: s.startSec,
    endSec: s.endSec,
    chord: s.chord,
  }));
}

export async function runNcAnatomy(): Promise<NcSongAnatomy[]> {
  const entries: NcSongAnatomy[] = [];

  // 合成（混合音・既定）
  mkdirSync(TEST_AUDIO_DIR, { recursive: true });
  for (const spec of SYNTH_SPECS) {
    const { samples, truth } = synthSong(spec, SAMPLE_RATE);
    const wavPath = join(TEST_AUDIO_DIR, `${spec.id}.wav`);
    const gtPath = join(TEST_AUDIO_DIR, `${spec.id}.groundtruth.json`);
    writeWav16(wavPath, samples, SAMPLE_RATE);
    writeFileSync(gtPath, JSON.stringify(truth, null, 2) + "\n", "utf-8");
    const wav = readWav16(wavPath);
    const result = await analyzeAudio(wav.samples, wav.sampleRate, `${spec.id}.wav`);
    const chroma = computeChromagram(wav.samples, wav.sampleRate, undefined, {
      chordBand: DEFAULT_CHORD_BAND,
    });
    const records = classifyNcSegments(
      result.segments,
      sourceOf(chroma),
      undefined,
      truthSpans(truth),
    );
    entries.push({
      suite: "synthetic",
      id: spec.id,
      title: spec.title,
      durationSec: result.duration,
      ncShare: ncShareOf(result),
      totals: summarizeNcRecords(records),
      records,
    });
  }

  // 実曲 混合音（既定）
  for (const slug of REAL_SLUGS) {
    const loaded = loadReal(slug, false);
    if (!loaded) continue;
    const result = await analyzeAudio(loaded.mixSamples, loaded.sampleRate, slug);
    const chroma = computeChromagram(loaded.mixSamples, loaded.sampleRate, undefined, {
      chordBand: DEFAULT_CHORD_BAND,
    });
    const records = classifyNcSegments(
      result.segments,
      sourceOf(chroma),
      undefined,
      truthSpans(loaded.truth),
    );
    entries.push({
      suite: "real-mixture",
      id: slug,
      title: loaded.title,
      durationSec: result.duration,
      ncShare: ncShareOf(result),
      totals: summarizeNcRecords(records),
      records,
    });
  }

  // 実曲 + Song D ステム（s-conditional）
  for (const slug of [...REAL_SLUGS, "song-d"]) {
    const loaded = loadReal(slug, true);
    if (!loaded?.chromas) continue;
    const result = analyzeStemsWithStrategy(
      loaded.chromas,
      loaded.sampleRate,
      slug,
      "s-conditional",
    );
    const records = classifyNcSegments(
      result.segments,
      sourceOf(loaded.chromas.otherChroma),
      {
        mix: sourceOf(loaded.chromas.mixChroma),
        bassFrames: loaded.chromas.bassChroma.bassFrames,
      },
      truthSpans(loaded.truth),
    );
    entries.push({
      suite: "real-stems",
      id: slug,
      title: loaded.title,
      durationSec: result.duration,
      ncShare: ncShareOf(result),
      totals: summarizeNcRecords(records),
      records,
    });
  }

  // Suno 05（正解なし）
  const suno = loadSuno();
  if (suno) {
    const mixResult = await analyzeAudio(suno.mixSamples, suno.sampleRate, "05.mp3");
    const mixChroma = computeChromagram(suno.mixSamples, suno.sampleRate, undefined, {
      chordBand: DEFAULT_CHORD_BAND,
    });
    const mixRecords = classifyNcSegments(mixResult.segments, sourceOf(mixChroma));
    entries.push({
      suite: "suno-mixture",
      id: "suno-05",
      title: "Suno 05（混合音）",
      durationSec: mixResult.duration,
      ncShare: ncShareOf(mixResult),
      totals: summarizeNcRecords(mixRecords),
      records: mixRecords,
    });
    const stemsResult = analyzeStemsWithStrategy(
      suno.chromas,
      suno.sampleRate,
      "05.mp3",
      "s-conditional",
    );
    const stemsRecords = classifyNcSegments(
      stemsResult.segments,
      sourceOf(suno.chromas.otherChroma),
      {
        mix: sourceOf(suno.chromas.mixChroma),
        bassFrames: suno.chromas.bassChroma.bassFrames,
      },
    );
    entries.push({
      suite: "suno-stems",
      id: "suno-05",
      title: "Suno 05（ステム）",
      durationSec: stemsResult.duration,
      ncShare: ncShareOf(stemsResult),
      totals: summarizeNcRecords(stemsRecords),
      records: stemsRecords,
    });
  }

  writeJson("nc-anatomy.json", entries);
  return entries;
}

interface SunoLoaded {
  mixSamples: Float32Array;
  sampleRate: number;
  chromas: StemChromas;
}

function loadSuno(): SunoLoaded | null {
  const mixPath = join(homedir(), "workspace/user/files/05.mp3");
  const stemRoot = join(PROJECT_ROOT, "stem-work/suno-05");
  const otherPath = findStemWav(stemRoot, "other");
  const bassPath = findStemWav(stemRoot, "bass");
  if (!otherPath || !bassPath || !existsSync(mixPath)) return null;
  const mix = loadAudioFile(mixPath);
  const other = loadAudioFile(otherPath);
  const bass = loadAudioFile(bassPath);
  return {
    mixSamples: mix.samples,
    sampleRate: mix.sampleRate,
    chromas: prepareStemChromas(mix.samples, other.samples, bass.samples, mix.sampleRate),
  };
}

// ---------------------------------------------------------------------------
// 介入（A/B）
// ---------------------------------------------------------------------------

export interface NcConversion {
  baselineNcSec: number;
  /** 正解コードがある時間で、介入がルート＋三和音コア正解に変換した秒数 */
  convertedCorrectSec: number;
  /** 正解コードがある時間で、介入が誤ラベルに変換した秒数 */
  convertedWrongSec: number;
  /** 介入後も N.C. のままの秒数（正解の有無を問わない） */
  stillNcSec: number;
  /** 正解が無い／解釈不能な時間で介入がラベルを付けた秒数（検証不能） */
  filledUnverifiableSec: number;
}

const CONV_STEP = 0.05;

/** ベースラインの N.C. 時間が、対象結果でどう変換されたかの会計
 * （FRAME_GATE.md の測定でも同じ定義で再利用する） */
export function measureConversion(
  baseline: AnalysisResult,
  recovery: AnalysisResult,
  truth: NcTruthSpan[] | null,
): NcConversion {
  let baselineNcSec = 0;
  let correct = 0;
  let wrong = 0;
  let still = 0;
  let unverifiable = 0;
  const recSegs = recovery.segments;
  let recIdx = 0;
  const recAt = (t: number) => {
    while (recIdx < recSegs.length - 1 && t >= recSegs[recIdx].end) recIdx++;
    const s = recSegs[recIdx];
    return s && t >= s.start && t < s.end ? s : null;
  };
  for (const seg of baseline.segments) {
    if (seg.chord !== NO_CHORD) continue;
    for (let t = seg.start; t < seg.end; t += CONV_STEP) {
      const mid = t + CONV_STEP / 2;
      baselineNcSec += CONV_STEP;
      const det = recAt(mid);
      if (!det || det.chord === NO_CHORD) {
        still += CONV_STEP;
        continue;
      }
      const gt = truth?.find((s) => mid >= s.startSec && mid < s.endSec) ?? null;
      const gtP = gt ? parseTruthChord(gt.chord) : null;
      const detP = parseChord(det.chord);
      if (!gtP || !detP) {
        unverifiable += CONV_STEP;
        continue;
      }
      const ok =
        detP.root === gtP.root &&
        (gtP.coreMode === null || detP.mode === gtP.coreMode);
      if (ok) correct += CONV_STEP;
      else wrong += CONV_STEP;
    }
  }
  const r = (x: number) => Number(x.toFixed(2));
  return {
    baselineNcSec: r(baselineNcSec),
    convertedCorrectSec: r(correct),
    convertedWrongSec: r(wrong),
    stillNcSec: r(still),
    filledUnverifiableSec: r(unverifiable),
  };
}

function filledBySource(result: AnalysisResult): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of result.segments) {
    if (!s.ncFill) continue;
    out[s.ncFill] = (out[s.ncFill] ?? 0) + (s.end - s.start);
  }
  for (const k of Object.keys(out)) out[k] = Number(out[k].toFixed(2));
  return out;
}

function nonNcIdentical(a: AnalysisResult, b: AnalysisResult): boolean {
  // 局所性: ベースラインで非 N.C. だったセグメントは、回復側でも
  // 同じ境界・同じラベルのまま存在しなければならない。回復側の
  // 非 N.C. が増えるのは、元 N.C. 区間への充填による分だけが正当。
  const key = (s: ChordSegment) => `${s.start.toFixed(3)}-${s.end.toFixed(3)}`;
  const fb = new Map(b.segments.map((s) => [key(s), s]));
  return a.segments
    .filter((s) => s.chord !== NO_CHORD)
    .every((s) => {
      const o = fb.get(key(s));
      return (
        o !== undefined &&
        o.chord === s.chord &&
        o.extension === s.extension &&
        o.bassPc === s.bassPc
      );
    });
}

/**
 * 充填された区間のうち「全域無音」だった秒数（ガードレール用）。
 * 全域無音 = 判定経路の gatedShare >= 0.95 かつ、副次経路（混合音）が
 * ある場合はそちらも >= 0.95。フェードアウト末尾などが該当する。
 */
function filledGlobalSilenceSec(
  recovery: AnalysisResult,
  judge: ChromaEvidenceSource,
  mix?: ChromaEvidenceSource,
): number {
  let sec = 0;
  for (const s of recovery.segments) {
    if (!s.ncFill) continue;
    const judgeEv = frameEvidence(judge, s.start, s.end);
    if (judgeEv.gatedShare < 0.95) continue;
    if (mix) {
      const mixEv = frameEvidence(mix, s.start, s.end);
      if (mixEv.gatedShare < 0.95) continue;
    }
    sec += s.end - s.start;
  }
  return Number(sec.toFixed(2));
}

export interface NcArmMetrics {
  root: number;
  triad: number;
  core: number | null;
  rootAllTime?: number;
  triadAllTime?: number;
}

export interface NcArmResult {
  ncShare: number;
  metrics: NcArmMetrics | null;
  conversion: NcConversion | null;
  filledBySource: Record<string, number>;
  nonNcIdentical: boolean;
  filledGlobalSilenceSec: number;
}

export interface NcRecoverySuite {
  suite: NcSongAnatomy["suite"];
  id: string;
  title: string;
  baseline: NcArmResult;
  arms: Record<string, NcArmResult>;
}

export interface NcRecoveryRun {
  suites: NcRecoverySuite[];
  sunoFixturesBaseline: SunoFixtureResult | null;
  sunoFixturesRecovery: SunoFixtureResult | null;
  /** Suno アウトロ（201 秒以降）が介入後も全て N.C. か（ステム all アーム） */
  sunoOutroStillNc: boolean | null;
}

const MIX_ARMS: Record<string, { ncSegmentRematch?: boolean; ncGapFill?: boolean }> = {
  rematch: { ncSegmentRematch: true },
  gapfill: { ncGapFill: true },
  all: { ncSegmentRematch: true, ncGapFill: true },
};
const STEM_ARMS: Record<
  string,
  { ncSegmentRematch?: boolean; ncStemsFallback?: boolean; ncGapFill?: boolean }
> = {
  rematch: { ncSegmentRematch: true },
  fallback: { ncStemsFallback: true },
  gapfill: { ncGapFill: true },
  all: { ncSegmentRematch: true, ncStemsFallback: true, ncGapFill: true },
};

function armResult(
  baseline: AnalysisResult,
  result: AnalysisResult,
  metrics: NcArmMetrics | null,
  truth: NcTruthSpan[] | null,
  judge: ChromaEvidenceSource,
  mix?: ChromaEvidenceSource,
): NcArmResult {
  return {
    ncShare: ncShareOf(result),
    metrics,
    conversion: truth ? measureConversion(baseline, result, truth) : null,
    filledBySource: filledBySource(result),
    nonNcIdentical: nonNcIdentical(baseline, result),
    filledGlobalSilenceSec: filledGlobalSilenceSec(result, judge, mix),
  };
}

export async function runNcRecovery(): Promise<NcRecoveryRun> {
  const suites: NcRecoverySuite[] = [];

  // 合成（混合音経路）
  mkdirSync(TEST_AUDIO_DIR, { recursive: true });
  for (const spec of SYNTH_SPECS) {
    const { samples, truth } = synthSong(spec, SAMPLE_RATE);
    const wavPath = join(TEST_AUDIO_DIR, `${spec.id}.wav`);
    writeWav16(wavPath, samples, SAMPLE_RATE);
    writeFileSync(
      join(TEST_AUDIO_DIR, `${spec.id}.groundtruth.json`),
      JSON.stringify(truth, null, 2) + "\n",
      "utf-8",
    );
    const wav = readWav16(wavPath);
    const chroma = computeChromagram(wav.samples, wav.sampleRate, undefined, {
      chordBand: DEFAULT_CHORD_BAND,
    });
    const judge = sourceOf(chroma);
    const spans = truthSpans(truth);
    const baseline = await analyzeAudio(wav.samples, wav.sampleRate, `${spec.id}.wav`);
    const bm = measureSong(truth, baseline);
    const baseArm = armResult(
      baseline,
      baseline,
      {
        root: bm.rootAccuracy,
        triad: bm.triadAccuracy,
        core: null,
        rootAllTime: bm.rootAccuracyAllTime,
        triadAllTime: bm.triadAccuracyAllTime,
      },
      spans,
      judge,
    );
    const arms: Record<string, NcArmResult> = {};
    for (const [name, opts] of Object.entries(MIX_ARMS)) {
      const result = await analyzeAudio(
        wav.samples,
        wav.sampleRate,
        `${spec.id}.wav`,
        undefined,
        opts,
      );
      const m = measureSong(truth, result);
      arms[name] = armResult(
        baseline,
        result,
        {
          root: m.rootAccuracy,
          triad: m.triadAccuracy,
          core: null,
          rootAllTime: m.rootAccuracyAllTime,
          triadAllTime: m.triadAccuracyAllTime,
        },
        spans,
        judge,
      );
    }
    suites.push({
      suite: "synthetic",
      id: spec.id,
      title: spec.title,
      baseline: baseArm,
      arms,
    });
  }

  // 実曲 混合音
  for (const slug of REAL_SLUGS) {
    const loaded = loadReal(slug, false);
    if (!loaded) continue;
    const chroma = computeChromagram(loaded.mixSamples, loaded.sampleRate, undefined, {
      chordBand: DEFAULT_CHORD_BAND,
    });
    const judge = sourceOf(chroma);
    const spans = truthSpans(loaded.truth);
    const baseline = await analyzeAudio(loaded.mixSamples, loaded.sampleRate, slug);
    const bm = measureRealSong(loaded.truth, baseline, "default");
    const baseArm = armResult(
      baseline,
      baseline,
      { root: bm.rootAccuracy, triad: bm.triadAccuracy, core: bm.coreAccuracy },
      spans,
      judge,
    );
    const arms: Record<string, NcArmResult> = {};
    for (const [name, opts] of Object.entries(MIX_ARMS)) {
      const result = await analyzeAudio(
        loaded.mixSamples,
        loaded.sampleRate,
        slug,
        undefined,
        opts,
      );
      const m = measureRealSong(loaded.truth, result, `default+nc-${name}`);
      arms[name] = armResult(
        baseline,
        result,
        { root: m.rootAccuracy, triad: m.triadAccuracy, core: m.coreAccuracy },
        spans,
        judge,
      );
    }
    suites.push({
      suite: "real-mixture",
      id: slug,
      title: loaded.title,
      baseline: baseArm,
      arms,
    });
  }

  // 実曲 + Song D ステム
  for (const slug of [...REAL_SLUGS, "song-d"]) {
    const loaded = loadReal(slug, true);
    if (!loaded?.chromas) continue;
    const judge = sourceOf(loaded.chromas.otherChroma);
    const mix = sourceOf(loaded.chromas.mixChroma);
    const spans = truthSpans(loaded.truth);
    const baseline = analyzeStemsWithStrategy(
      loaded.chromas,
      loaded.sampleRate,
      slug,
      "s-conditional",
    );
    const bm = measureRealSong(loaded.truth, baseline, "stems");
    const baseArm = armResult(
      baseline,
      baseline,
      { root: bm.rootAccuracy, triad: bm.triadAccuracy, core: bm.coreAccuracy },
      spans,
      judge,
      mix,
    );
    const arms: Record<string, NcArmResult> = {};
    for (const [name, opts] of Object.entries(STEM_ARMS)) {
      const result = analyzeStemsWithStrategy(
        loaded.chromas,
        loaded.sampleRate,
        slug,
        "s-conditional",
        opts,
      );
      const m = measureRealSong(loaded.truth, result, `stems+nc-${name}`);
      arms[name] = armResult(
        baseline,
        result,
        { root: m.rootAccuracy, triad: m.triadAccuracy, core: m.coreAccuracy },
        spans,
        judge,
        mix,
      );
    }
    suites.push({
      suite: "real-stems",
      id: slug,
      title: loaded.title,
      baseline: baseArm,
      arms,
    });
  }

  // Suno 05（N.C. 割合とフィクスチャのみ）
  let sunoFixturesBaseline: SunoFixtureResult | null = null;
  let sunoFixturesRecovery: SunoFixtureResult | null = null;
  let sunoOutroStillNc: boolean | null = null;
  const suno = loadSuno();
  if (suno) {
    const mixChroma = computeChromagram(suno.mixSamples, suno.sampleRate, undefined, {
      chordBand: DEFAULT_CHORD_BAND,
    });
    const mixJudge = sourceOf(mixChroma);
    const mixBase = await analyzeAudio(suno.mixSamples, suno.sampleRate, "05.mp3");
    const mixBaseArm = armResult(mixBase, mixBase, null, null, mixJudge);
    const mixArms: Record<string, NcArmResult> = {};
    for (const [name, opts] of Object.entries(MIX_ARMS)) {
      const result = await analyzeAudio(
        suno.mixSamples,
        suno.sampleRate,
        "05.mp3",
        undefined,
        opts,
      );
      mixArms[name] = armResult(mixBase, result, null, null, mixJudge);
    }
    suites.push({
      suite: "suno-mixture",
      id: "suno-05",
      title: "Suno 05（混合音）",
      baseline: mixBaseArm,
      arms: mixArms,
    });

    const stemsJudge = sourceOf(suno.chromas.otherChroma);
    const stemsMix = sourceOf(suno.chromas.mixChroma);
    const stemsBase = analyzeStemsWithStrategy(
      suno.chromas,
      suno.sampleRate,
      "05.mp3",
      "s-conditional",
    );
    const stemsBaseArm = armResult(stemsBase, stemsBase, null, null, stemsJudge, stemsMix);
    const stemsArms: Record<string, NcArmResult> = {};
    for (const [name, opts] of Object.entries(STEM_ARMS)) {
      const result = analyzeStemsWithStrategy(
        suno.chromas,
        suno.sampleRate,
        "05.mp3",
        "s-conditional",
        opts,
      );
      stemsArms[name] = armResult(stemsBase, result, null, null, stemsJudge, stemsMix);
      if (name === "all") {
        // アウトロの N.C. セグメントは 201.13 開始。開始時刻で選ぶ
        // （201.13 に「終わる」最後の実コード区間を巻き込まないため）。
        sunoOutroStillNc = result.segments
          .filter((s) => s.start >= 201)
          .every((s) => s.chord === NO_CHORD);
      }
    }
    suites.push({
      suite: "suno-stems",
      id: "suno-05",
      title: "Suno 05（ステム）",
      baseline: stemsBaseArm,
      arms: stemsArms,
    });

    const mixBaseExt = await analyzeAudio(
      suno.mixSamples,
      suno.sampleRate,
      "05.mp3",
      undefined,
      { extensions: true },
    );
    const mixRecExt = await analyzeAudio(
      suno.mixSamples,
      suno.sampleRate,
      "05.mp3",
      undefined,
      { extensions: true, ...MIX_ARMS.all },
    );
    const stemsBaseExt = analyzeStemsWithStrategy(
      suno.chromas,
      suno.sampleRate,
      "05.mp3",
      "s-conditional",
      { extensions: true },
    );
    const stemsRecExt = analyzeStemsWithStrategy(
      suno.chromas,
      suno.sampleRate,
      "05.mp3",
      "s-conditional",
      { extensions: true, ...STEM_ARMS.all },
    );
    const stemsRec = analyzeStemsWithStrategy(
      suno.chromas,
      suno.sampleRate,
      "05.mp3",
      "s-conditional",
      STEM_ARMS.all,
    );
    const mixRec = await analyzeAudio(
      suno.mixSamples,
      suno.sampleRate,
      "05.mp3",
      undefined,
      MIX_ARMS.all,
    );
    sunoFixturesBaseline = evaluateSunoFixtures(stemsBase, stemsBaseExt, mixBase, mixBaseExt);
    sunoFixturesRecovery = evaluateSunoFixtures(stemsRec, stemsRecExt, mixRec, mixRecExt);
  }

  const run: NcRecoveryRun = {
    suites,
    sunoFixturesBaseline,
    sunoFixturesRecovery,
    sunoOutroStillNc,
  };
  writeJson("nc-recovery.json", run);
  return run;
}

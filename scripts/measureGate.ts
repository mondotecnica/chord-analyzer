/**
 * フレームゲート再設計（曲参照ゲート）の測定ハーネス。
 *
 * 設計と事前登録基準は measurements/nc/FRAME_GATE.md。本ハーネスは
 * 数値を出すだけで、採用判定は文書側で行う（NC ラウンドと同じ規律）。
 *
 * スイート構成は measureNc.ts と同一（素材・既定経路も同一）:
 * - 合成 A–I（混合音・アプリ既定 = split）
 * - 実曲 1–3（混合音・既定 / ステム s-conditional）＋ Song D ステム
 * - Suno 05（混合音・既定 / ステム s-conditional、正解なし）
 *
 * アーム:
 * - 混合音: legacy / song（曲参照。参照 ≡ 判定経路のため legacy に
 *   帰着するはずで、そのビット一致を検証する）
 * - ステム: legacy / song（救済フロア比率 0 = 原則点） / r03 / r05 /
 *   r10（フロンティア） / song+rematch / song+rematch+gapfill
 *   （新ゲートと N.C. 回復の組み合わせ）
 *
 * 各アームで記録する: N.C. 割合、精度、legacy の N.C. 時間に対する
 * 変換会計（measureNc.measureConversion と同義）、legacy の判定済み
 * 時間に対する churn 会計、真の無音ウィンドウ内の判定済み秒数。
 *
 * 生成物: measurements/nc/frame-gate.json
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeAudio } from "../src/analysis/analyze";
import {
  analyzeStemsWithStrategy,
  prepareStemChromas,
  type StemChromas,
} from "../src/analysis/analyzeStems";
import type { FrameGateMode } from "../src/analysis/chordEstimation";
import { NO_CHORD } from "../src/lib/notes";
import type { AnalysisResult } from "../src/types";
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
import { measureConversion, type NcArmMetrics } from "./measureNc";
import type { NcTruthSpan } from "./ncAnatomy";
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

const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));
const NC_DIR = join(PROJECT_ROOT, "measurements", "nc");
const SAMPLE_RATE = 44100;

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

/** AHDN の真の無音ウィンドウ開始（正解終了 = 150.1 秒、NC_ANALYSIS §3） */
const AHDN_SILENCE_FROM = 150.1;
/** Suno アウトロの開始（両経路ゲート率 1.0 の真のフェード） */
const SUNO_SILENCE_FROM = 201;

function writeJson(name: string, data: unknown): void {
  mkdirSync(NC_DIR, { recursive: true });
  writeFileSync(join(NC_DIR, name), JSON.stringify(data, null, 2) + "\n", "utf-8");
}

function ncShareOf(result: AnalysisResult): number {
  let nc = 0;
  for (const s of result.segments) {
    if (s.chord === NO_CHORD) nc += s.end - s.start;
  }
  return result.duration > 0 ? nc / result.duration : 0;
}

// ---------------------------------------------------------------------------
// churn 会計（legacy の判定済み時間に対するラベルの動き）
// ---------------------------------------------------------------------------

export interface GateChurn {
  /** legacy で判定済み（非 N.C.）だった総秒数（正解の有無を問わない） */
  judgedSec: number;
  /** 判定済み時間のうち、ラベル文字列が変わった秒数 */
  labelChangedSec: number;
  /** 判定済み → N.C. になった秒数 */
  judgedToNcSec: number;
  /** 正解時間での内訳（正解が無いスイートでは null） */
  correctToWrongSec: number | null;
  correctToNcSec: number | null;
  wrongToCorrectSec: number | null;
  wrongToWrongDiffSec: number | null;
}

const CHURN_STEP = 0.05;

function segLookup(segs: AnalysisResult["segments"]) {
  let idx = 0;
  return (t: number): string | null => {
    while (idx < segs.length - 1 && t >= segs[idx].end) idx++;
    const s = segs[idx];
    return s && t >= s.start && t < s.end ? s.chord : null;
  };
}

function measureChurn(
  baseline: AnalysisResult,
  arm: AnalysisResult,
  truth: NcTruthSpan[] | null,
): GateChurn {
  const baseAt = segLookup(baseline.segments);
  const armAt = segLookup(arm.segments);
  const duration = Math.min(baseline.duration, arm.duration);
  let judged = 0;
  let labelChanged = 0;
  let judgedToNc = 0;
  let c2w = 0;
  let c2n = 0;
  let w2c = 0;
  let w2w = 0;
  for (let t = 0; t < duration; t += CHURN_STEP) {
    const mid = t + CHURN_STEP / 2;
    const baseChord = baseAt(mid);
    if (!baseChord || baseChord === NO_CHORD) continue;
    judged += CHURN_STEP;
    const armChord = armAt(mid);
    const armIsNc = !armChord || armChord === NO_CHORD;
    if (armIsNc) judgedToNc += CHURN_STEP;
    if ((armChord ?? NO_CHORD) !== baseChord) labelChanged += CHURN_STEP;
    if (!truth) continue;
    const gt = truth.find((s) => mid >= s.startSec && mid < s.endSec) ?? null;
    const gtP = gt ? parseTruthChord(gt.chord) : null;
    const baseP = parseChord(baseChord);
    if (!gtP || !baseP) continue;
    const isCorrect = (chord: string): boolean => {
      const p = parseChord(chord);
      return (
        p !== null &&
        p.root === gtP.root &&
        (gtP.coreMode === null || p.mode === gtP.coreMode)
      );
    };
    const baseCorrect = isCorrect(baseChord);
    if (baseCorrect) {
      if (armIsNc) c2n += CHURN_STEP;
      else if (!isCorrect(armChord)) c2w += CHURN_STEP;
    } else {
      if (!armIsNc && isCorrect(armChord)) w2c += CHURN_STEP;
      else if (!armIsNc && armChord !== baseChord) w2w += CHURN_STEP;
    }
  }
  const r = (x: number) => Number(x.toFixed(2));
  return {
    judgedSec: r(judged),
    labelChangedSec: r(labelChanged),
    judgedToNcSec: r(judgedToNc),
    correctToWrongSec: truth ? r(c2w) : null,
    correctToNcSec: truth ? r(c2n) : null,
    wrongToCorrectSec: truth ? r(w2c) : null,
    wrongToWrongDiffSec: truth ? r(w2w) : null,
  };
}

/** [fromSec, 曲尾] のうち判定済み（非 N.C.）だった秒数。真の無音の保護確認用 */
function judgedSecInWindow(result: AnalysisResult, fromSec: number): number {
  let sec = 0;
  for (const s of result.segments) {
    if (s.chord === NO_CHORD) continue;
    const overlap = Math.min(s.end, result.duration) - Math.max(s.start, fromSec);
    if (overlap > 0) sec += overlap;
  }
  return Number(sec.toFixed(2));
}

/**
 * fromSec 以降に「始まる」セグメントが全て N.C. か（NC ラウンドの
 * アウトロ判定と同じ定義）。ウィンドウ境界をまたぐ最後の実コード
 * セグメントの残響は含まない（重なり秒数は judgedSecInWindow 側で
 * legacy との比較として別に見る）。
 */
function silenceWindowStartsNc(result: AnalysisResult, fromSec: number): boolean {
  return result.segments
    .filter((s) => s.start >= fromSec)
    .every((s) => s.chord === NO_CHORD);
}

function segmentsIdentical(a: AnalysisResult, b: AnalysisResult): boolean {
  if (a.segments.length !== b.segments.length) return false;
  return a.segments.every((s, i) => {
    const o = b.segments[i];
    return (
      o !== undefined &&
      s.start === o.start &&
      s.end === o.end &&
      s.chord === o.chord &&
      s.confidence === o.confidence &&
      s.extension === o.extension &&
      s.bassPc === o.bassPc
    );
  });
}

// ---------------------------------------------------------------------------
// アーム定義
// ---------------------------------------------------------------------------

interface GateArmOptions {
  frameGate?: FrameGateMode;
  frameGateRescueFloorRatio?: number;
  ncSegmentRematch?: boolean;
  ncGapFill?: boolean;
}

const MIX_ARMS: Record<string, GateArmOptions> = {
  legacy: { frameGate: "legacy" },
  song: { frameGate: "song-referenced" },
};

const STEM_ARMS: Record<string, GateArmOptions> = {
  legacy: { frameGate: "legacy" },
  song: { frameGate: "song-referenced" },
  r03: { frameGate: "song-referenced", frameGateRescueFloorRatio: 0.03 },
  r05: { frameGate: "song-referenced", frameGateRescueFloorRatio: 0.05 },
  r10: { frameGate: "song-referenced", frameGateRescueFloorRatio: 0.1 },
  "song-rematch": { frameGate: "song-referenced", ncSegmentRematch: true },
  "song-rematch-gapfill": {
    frameGate: "song-referenced",
    ncSegmentRematch: true,
    ncGapFill: true,
  },
};

// ---------------------------------------------------------------------------
// 素材ロード（measureNc.ts と同じ素材・同じ読み方）
// ---------------------------------------------------------------------------

interface LoadedReal {
  slug: string;
  title: string;
  truth: RealTruth;
  mixSamples: Float32Array;
  sampleRate: number;
  chromas?: StemChromas;
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
    loaded.chromas = prepareStemChromas(
      mix.samples,
      other.samples,
      bass.samples,
      mix.sampleRate,
    );
  }
  return loaded;
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

function truthSpans(truth: RealTruth | GroundTruth): NcTruthSpan[] {
  return truth.segments.map((s) => ({
    startSec: s.startSec,
    endSec: s.endSec,
    chord: s.chord,
  }));
}

// ---------------------------------------------------------------------------
// 実行
// ---------------------------------------------------------------------------

export interface GateArmResult {
  ncShare: number;
  metrics: NcArmMetrics | null;
  conversion: ReturnType<typeof measureConversion> | null;
  churn: GateChurn;
  /** legacy とセグメント列（境界・ラベル・信頼度・付帯情報）が完全一致するか */
  segmentsIdenticalToLegacy: boolean;
  /** 真の無音ウィンドウ内の判定済み秒数（ウィンドウが無いスイートは null） */
  judgedSecInSilenceWindow: number | null;
  /** ウィンドウ以降に始まるセグメントが全て N.C. か（ウィンドウが無いスイートは null） */
  silenceWindowStartsNc: boolean | null;
}

export interface GateSuite {
  suite: "synthetic" | "real-mixture" | "real-stems" | "suno-mixture" | "suno-stems";
  id: string;
  title: string;
  durationSec: number;
  arms: Record<string, GateArmResult>;
}

export interface GateRun {
  suites: GateSuite[];
  sunoFixturesLegacy: SunoFixtureResult | null;
  sunoFixturesSong: SunoFixtureResult | null;
}

function armResult(
  baseline: AnalysisResult,
  result: AnalysisResult,
  metrics: NcArmMetrics | null,
  truth: NcTruthSpan[] | null,
  silenceFrom: number | null,
): GateArmResult {
  return {
    ncShare: ncShareOf(result),
    metrics,
    conversion: measureConversion(baseline, result, truth),
    churn: measureChurn(baseline, result, truth),
    segmentsIdenticalToLegacy: segmentsIdentical(baseline, result),
    judgedSecInSilenceWindow:
      silenceFrom !== null ? judgedSecInWindow(result, silenceFrom) : null,
    silenceWindowStartsNc:
      silenceFrom !== null ? silenceWindowStartsNc(result, silenceFrom) : null,
  };
}

export async function runFrameGate(): Promise<GateRun> {
  const suites: GateSuite[] = [];

  // 合成（混合音経路）
  for (const spec of SYNTH_SPECS) {
    const { samples, truth } = synthSong(spec, SAMPLE_RATE);
    const spans = truthSpans(truth);
    const baseline = await analyzeAudio(samples, SAMPLE_RATE, `${spec.id}.wav`, undefined, MIX_ARMS.legacy);
    const bm = measureSong(truth, baseline);
    const arms: Record<string, GateArmResult> = {
      legacy: armResult(
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
        null,
      ),
    };
    for (const [name, opts] of Object.entries(MIX_ARMS)) {
      if (name === "legacy") continue;
      const result = await analyzeAudio(samples, SAMPLE_RATE, `${spec.id}.wav`, undefined, opts);
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
        null,
      );
    }
    suites.push({
      suite: "synthetic",
      id: spec.id,
      title: spec.title,
      durationSec: baseline.duration,
      arms,
    });
  }

  // 実曲 混合音
  for (const slug of REAL_SLUGS) {
    const loaded = loadReal(slug, false);
    if (!loaded) continue;
    const spans = truthSpans(loaded.truth);
    const silenceFrom = slug === "a-hard-days-night" ? AHDN_SILENCE_FROM : null;
    const baseline = await analyzeAudio(loaded.mixSamples, loaded.sampleRate, slug, undefined, MIX_ARMS.legacy);
    const bm = measureRealSong(loaded.truth, baseline, "gate-legacy");
    const arms: Record<string, GateArmResult> = {
      legacy: armResult(
        baseline,
        baseline,
        { root: bm.rootAccuracy, triad: bm.triadAccuracy, core: bm.coreAccuracy },
        spans,
        silenceFrom,
      ),
    };
    for (const [name, opts] of Object.entries(MIX_ARMS)) {
      if (name === "legacy") continue;
      const result = await analyzeAudio(loaded.mixSamples, loaded.sampleRate, slug, undefined, opts);
      const m = measureRealSong(loaded.truth, result, `gate-${name}`);
      arms[name] = armResult(
        baseline,
        result,
        { root: m.rootAccuracy, triad: m.triadAccuracy, core: m.coreAccuracy },
        spans,
        silenceFrom,
      );
    }
    suites.push({
      suite: "real-mixture",
      id: slug,
      title: loaded.title,
      durationSec: baseline.duration,
      arms,
    });
  }

  // 実曲 + Song D ステム
  for (const slug of [...REAL_SLUGS, "song-d"]) {
    const loaded = loadReal(slug, true);
    if (!loaded?.chromas) continue;
    const spans = truthSpans(loaded.truth);
    const silenceFrom = slug === "a-hard-days-night" ? AHDN_SILENCE_FROM : null;
    const baseline = analyzeStemsWithStrategy(
      loaded.chromas,
      loaded.sampleRate,
      slug,
      "s-conditional",
      STEM_ARMS.legacy,
    );
    const bm = measureRealSong(loaded.truth, baseline, "gate-legacy");
    const arms: Record<string, GateArmResult> = {
      legacy: armResult(
        baseline,
        baseline,
        { root: bm.rootAccuracy, triad: bm.triadAccuracy, core: bm.coreAccuracy },
        spans,
        silenceFrom,
      ),
    };
    for (const [name, opts] of Object.entries(STEM_ARMS)) {
      if (name === "legacy") continue;
      const result = analyzeStemsWithStrategy(
        loaded.chromas,
        loaded.sampleRate,
        slug,
        "s-conditional",
        opts,
      );
      const m = measureRealSong(loaded.truth, result, `gate-${name}`);
      arms[name] = armResult(
        baseline,
        result,
        { root: m.rootAccuracy, triad: m.triadAccuracy, core: m.coreAccuracy },
        spans,
        silenceFrom,
      );
    }
    suites.push({
      suite: "real-stems",
      id: slug,
      title: loaded.title,
      durationSec: baseline.duration,
      arms,
    });
  }

  // Suno 05
  let sunoFixturesLegacy: SunoFixtureResult | null = null;
  let sunoFixturesSong: SunoFixtureResult | null = null;
  const suno = loadSuno();
  if (suno) {
    // 混合音
    const mixBase = await analyzeAudio(suno.mixSamples, suno.sampleRate, "05.mp3", undefined, MIX_ARMS.legacy);
    const mixArms: Record<string, GateArmResult> = {
      legacy: armResult(mixBase, mixBase, null, null, SUNO_SILENCE_FROM),
    };
    for (const [name, opts] of Object.entries(MIX_ARMS)) {
      if (name === "legacy") continue;
      const result = await analyzeAudio(suno.mixSamples, suno.sampleRate, "05.mp3", undefined, opts);
      mixArms[name] = armResult(mixBase, result, null, null, SUNO_SILENCE_FROM);
    }
    suites.push({
      suite: "suno-mixture",
      id: "suno-05",
      title: "Suno 05（混合音）",
      durationSec: mixBase.duration,
      arms: mixArms,
    });

    // ステム
    const stemsBase = analyzeStemsWithStrategy(
      suno.chromas,
      suno.sampleRate,
      "05.mp3",
      "s-conditional",
      STEM_ARMS.legacy,
    );
    const stemsArms: Record<string, GateArmResult> = {
      legacy: armResult(stemsBase, stemsBase, null, null, SUNO_SILENCE_FROM),
    };
    for (const [name, opts] of Object.entries(STEM_ARMS)) {
      if (name === "legacy") continue;
      const result = analyzeStemsWithStrategy(
        suno.chromas,
        suno.sampleRate,
        "05.mp3",
        "s-conditional",
        opts,
      );
      stemsArms[name] = armResult(stemsBase, result, null, null, SUNO_SILENCE_FROM);
    }
    suites.push({
      suite: "suno-stems",
      id: "suno-05",
      title: "Suno 05（ステム）",
      durationSec: stemsBase.duration,
      arms: stemsArms,
    });

    // フィクスチャ（ゲート別に、拡張 OFF/ON の4結果を evaluateSunoFixtures へ）
    const fixtureFor = async (gate: GateArmOptions) => {
      const stemsOff = analyzeStemsWithStrategy(
        suno.chromas,
        suno.sampleRate,
        "05.mp3",
        "s-conditional",
        gate,
      );
      const stemsOn = analyzeStemsWithStrategy(
        suno.chromas,
        suno.sampleRate,
        "05.mp3",
        "s-conditional",
        { ...gate, extensions: true },
      );
      const mixOff = await analyzeAudio(
        suno.mixSamples,
        suno.sampleRate,
        "05.mp3",
        undefined,
        gate,
      );
      const mixOn = await analyzeAudio(
        suno.mixSamples,
        suno.sampleRate,
        "05.mp3",
        undefined,
        { ...gate, extensions: true },
      );
      return evaluateSunoFixtures(stemsOff, stemsOn, mixOff, mixOn);
    };
    sunoFixturesLegacy = await fixtureFor(MIX_ARMS.legacy);
    sunoFixturesSong = await fixtureFor(MIX_ARMS.song);
  }

  const run: GateRun = { suites, sunoFixturesLegacy, sunoFixturesSong };
  writeJson("frame-gate.json", run);
  return run;
}

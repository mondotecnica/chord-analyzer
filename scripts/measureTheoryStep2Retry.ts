/**
 * Theory Engine 第2段・再挑戦（v2）の測定ハーネス。
 *
 * 測るもの（measurements/theory/THEORY_ENGINE_STEP2_RETRY.md の
 * 事前登録基準）:
 * 1. 非劣性: 合成 A〜I 混合音・Song D ステムの root／triad Δ
 * 2. 改善: 実曲 1〜3（混合音・ステム別）の root／triad／core Δ
 * 3. フィクスチャ関門: Q3-Am 保全（独立項目 3a）、Q3-B7 の回復
 *    維持、Q2 の Cm 非復活、Q1／Q4 の維持、Q3-C／E7 の悪化なし
 * 4. Song D 混合音の triad Δ
 * 5. 不変性: theoryReevaluationV2 OFF が baseline と一致する
 *    こと、v1（初回主構成）の baseline／再評価が初回測定の保存値
 *    （theory-step2-results.json）と一致すること、N.C. 変動ゼロ
 * あわせて反転の内訳（修正秒／破壊秒／両誤り変更秒）と、柱の
 * ablation（no-gate／no-home／no-floor、合否には使わない）、
 * v1 の再掲（参考）を記録する。
 *
 * 実行: npm run measure:theory-step2-retry（vitest 経由）
 * 結果: measurements/theory/theory-step2-retry-results.json
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeAudio } from "../src/analysis/analyze";
import {
  analyzeStemsAudio,
  analyzeStemsWithStrategy,
  prepareStemChromas,
} from "../src/analysis/analyzeStems";
import { parseChordName } from "../src/analysis/bassCorrection";
import {
  applyTheoryReevaluation,
  THEORY_WEIGHTS,
  THEORY_WEIGHTS_V2,
  type TheoryWeights,
} from "../src/analysis/theoryReevaluation";
import { NO_CHORD } from "../src/lib/notes";
import type { AnalysisResult, ChordSegment } from "../src/types";
import { loadAudioFile, parseTruthChord, parseTruthJson } from "./measureReal";
import { findStemWav, STEM_SONGS } from "./measureStems";
import { sunoYoiReady } from "./measureSunoYoi";
import {
  coverageShares,
  coverageVsTruth,
  labelSignature,
  newCoverageAcc,
  SUNO_FIXTURE_WINDOWS,
  type CoverageAcc,
  type TruthSeg,
} from "./measureTheoryStep1";
import { flipBreakdown, type FlipBreakdown } from "./measureTheoryStep2";
import { readWav16 } from "./wav";

const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT_DIR = join(PROJECT_ROOT, "measurements", "theory");
const OUT_PATH = join(OUT_DIR, "theory-step2-retry-results.json");
const STEP2_PATH = join(OUT_DIR, "theory-step2-results.json");
const STEP = 0.05;

function addCoverage(acc: CoverageAcc, other: CoverageAcc) {
  acc.denom += other.denom;
  acc.denomTriad += other.denomTriad;
  acc.ncSec += other.ncSec;
  other.root.forEach((v, i) => (acc.root[i] += v));
  other.triad.forEach((v, i) => (acc.triad[i] += v));
  other.core.forEach((v, i) => (acc.core[i] += v));
}

/** 再評価後の top-1 を coverageVsTruth で測れる形にする */
function asTop1(result: AnalysisResult): AnalysisResult {
  return {
    ...result,
    segments: result.segments.map((s) => {
      if (s.chord === NO_CHORD) return s;
      const p = parseChordName(s.chord);
      if (!p) return s;
      return {
        ...s,
        candidates: [{ root: p.root, mode: p.mode, score: 0, margin: 0 }],
      };
    }),
  };
}

function profileOf(result: AnalysisResult) {
  return {
    keyRoot: result.keyRoot,
    keyMode: result.keyMode,
    ...(result.localKeys ? { localKeys: result.localKeys } : {}),
  };
}

function applyPure(
  baseline: AnalysisResult,
  weights: TheoryWeights,
): AnalysisResult {
  return {
    ...baseline,
    segments: applyTheoryReevaluation(baseline.segments, profileOf(baseline), weights),
  };
}

// ---------------------------------------------------------------------------
// フィクスチャ（ラベル時間割合）
// ---------------------------------------------------------------------------

export interface FixtureLabelShare {
  name: string;
  negative: boolean;
  baseline: number;
  reeval: number;
  bassBaseline?: number;
  bassReeval?: number;
}

function labelAt(segs: ChordSegment[], mid: number) {
  let lo = 0;
  let hi = segs.length - 1;
  let idx = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (mid < segs[m].start) hi = m - 1;
    else if (mid >= segs[m].end) lo = m + 1;
    else {
      idx = m;
      break;
    }
  }
  if (idx < 0) return null;
  const s = segs[idx];
  if (s.chord === NO_CHORD) return null;
  return parseChordName(s.chord);
}

function labelShare(
  result: AnalysisResult,
  range: [number, number],
  target: { root: number; mode: "major" | "minor" },
  bassPc?: number,
): { share: number; bassShare?: number } {
  const [lo, hi] = range;
  let hit = 0;
  let bassHit = 0;
  let total = 0;
  for (let t = lo; t < hi; t += STEP) {
    const mid = t + STEP / 2;
    total += STEP;
    const p = labelAt(result.segments, mid);
    if (p && p.root === target.root && p.mode === target.mode) hit += STEP;
    if (bassPc !== undefined) {
      const s = result.segments.find((x) => mid >= x.start && mid < x.end);
      if (s && s.bassPc === bassPc) bassHit += STEP;
    }
  }
  return {
    share: total > 0 ? hit / total : 0,
    ...(bassPc !== undefined
      ? { bassShare: total > 0 ? bassHit / total : 0 }
      : {}),
  };
}

function fixtureShares(
  baseline: AnalysisResult,
  reeval: AnalysisResult,
): FixtureLabelShare[] {
  return SUNO_FIXTURE_WINDOWS.map((w) => {
    const b = labelShare(baseline, w.range, w.settled!, w.settledBassPc);
    const r = labelShare(reeval, w.range, w.settled!, w.settledBassPc);
    return {
      name: w.name,
      negative: w.negative === true,
      baseline: b.share,
      reeval: r.share,
      ...(w.settledBassPc !== undefined
        ? { bassBaseline: b.bassShare, bassReeval: r.bassShare }
        : {}),
    };
  });
}

// ---------------------------------------------------------------------------
// スイート実行
// ---------------------------------------------------------------------------

export interface SuiteStep2Retry {
  suite: string;
  path: "mixture" | "stems";
  /** theoryReevaluationV2 OFF（明示 false）が baseline と完全一致したか */
  offInvariant: boolean;
  ncBaselineSec: number;
  ncReevalSec: number;
  baseline: CoverageAcc | null;
  reeval: CoverageAcc | null;
  /** 参考: v1（初回主構成）を baseline へ純粋関数で適用した被覆 */
  reevalV1: CoverageAcc | null;
  flips: FlipBreakdown | null;
  flipsV1: FlipBreakdown | null;
  fixtures?: FixtureLabelShare[];
  fixturesV1?: FixtureLabelShare[];
}

interface Trio {
  baseline: AnalysisResult;
  off: AnalysisResult;
  reeval: AnalysisResult;
}

function checkSuite(
  suite: string,
  path: "mixture" | "stems",
  trio: Trio,
  truth: TruthSeg[] | null,
  withFixtures: boolean,
): SuiteStep2Retry {
  const ncSec = (r: AnalysisResult) =>
    r.segments
      .filter((s) => s.chord === NO_CHORD)
      .reduce((a, s) => a + (s.end - s.start), 0);
  const v1 = applyPure(trio.baseline, THEORY_WEIGHTS);
  return {
    suite,
    path,
    offInvariant: labelSignature(trio.baseline) === labelSignature(trio.off),
    ncBaselineSec: ncSec(trio.baseline),
    ncReevalSec: ncSec(trio.reeval),
    baseline: truth ? coverageVsTruth(truth, trio.baseline, "labeled") : null,
    reeval: truth ? coverageVsTruth(truth, asTop1(trio.reeval), "labeled") : null,
    reevalV1: truth ? coverageVsTruth(truth, asTop1(v1), "labeled") : null,
    flips: truth ? flipBreakdown(truth, trio.baseline, trio.reeval) : null,
    flipsV1: truth ? flipBreakdown(truth, trio.baseline, v1) : null,
    ...(withFixtures
      ? {
          fixtures: fixtureShares(trio.baseline, trio.reeval),
          fixturesV1: fixtureShares(trio.baseline, v1),
        }
      : {}),
  };
}

function groundTruthSegs(path: string): TruthSeg[] {
  const raw = JSON.parse(readFileSync(path, "utf-8")) as {
    segments: { startSec: number; endSec: number; chord: string }[];
  };
  return raw.segments.flatMap((s) => {
    const p = parseChordName(s.chord);
    return p
      ? [{ start: s.startSec, end: s.endSec, root: p.root, coreMode: p.mode }]
      : [];
  });
}

function realTruthSegs(path: string): TruthSeg[] {
  const truth = parseTruthJson(JSON.parse(readFileSync(path, "utf-8")), path);
  return truth.segments.flatMap((s) => {
    const p = parseTruthChord(s.chord);
    return p
      ? [{ start: s.startSec, end: s.endSec, root: p.root, coreMode: p.coreMode }]
      : [];
  });
}

// 柱の ablation（合否には使わない。baseline への純粋関数適用）
export const ABLATION_VARIANTS: Record<string, TheoryWeights> = {
  "v2-nogate": { ...THEORY_WEIGHTS_V2, keyGate: undefined },
  "v2-nohome": { ...THEORY_WEIGHTS_V2, homeAdvantage: 0 },
  "v2-nofloor": { ...THEORY_WEIGHTS_V2, emissionFloorAtZero: false },
};

export interface TheoryStep2RetryResults {
  generatedAt: string;
  weights: TheoryWeights;
  suites: SuiteStep2Retry[];
  aggregates: Record<
    string,
    { baseline: CoverageAcc; reeval: CoverageAcc; reevalV1: CoverageAcc }
  >;
  /** 柱の ablation の集計被覆（k=1 = top-1 相当） */
  ablations: Record<string, Record<string, CoverageAcc>>;
  /** ablation のフィクスチャ挙動（合否には使わない） */
  fixtureAblations: Record<string, FixtureLabelShare[]>;
  /** 初回保存値との一致確認（baseline／v1 の集計 k=1 シェアの最大偏差） */
  step2Consistency: {
    baselineMaxDev: number;
    v1MaxDev: number;
  };
  totals: {
    offInvariantSuites: number;
    totalSuites: number;
    ncDeltaMaxSec: number;
  };
}

export async function runTheoryStep2RetryMeasurement(): Promise<TheoryStep2RetryResults> {
  const suites: SuiteStep2Retry[] = [];
  const groups = ["mixture-synth", "mixture-real", "stems-real", "stems-song-d"];
  const aggBase: Record<string, CoverageAcc> = {};
  const aggRe: Record<string, CoverageAcc> = {};
  const aggV1: Record<string, CoverageAcc> = {};
  for (const g of groups) {
    aggBase[g] = newCoverageAcc();
    aggRe[g] = newCoverageAcc();
    aggV1[g] = newCoverageAcc();
  }
  const ablations: Record<string, Record<string, CoverageAcc>> = {};
  for (const name of Object.keys(ABLATION_VARIANTS)) {
    ablations[name] = {};
    for (const g of ["mixture-synth", "mixture-real", "stems-real"]) {
      ablations[name][g] = newCoverageAcc();
    }
  }
  const ablationInputs: { group: string; baseline: AnalysisResult; truth: TruthSeg[] }[] = [];
  const fixtureBaselines: { suite: string; baseline: AnalysisResult }[] = [];

  const register = (
    outcome: SuiteStep2Retry,
    group: string | null,
    baseline: AnalysisResult,
    truth: TruthSeg[] | null,
  ) => {
    suites.push(outcome);
    if (group && truth && outcome.baseline && outcome.reeval && outcome.reevalV1) {
      addCoverage(aggBase[group], outcome.baseline);
      addCoverage(aggRe[group], outcome.reeval);
      addCoverage(aggV1[group], outcome.reevalV1);
      if (group !== "stems-song-d") {
        ablationInputs.push({ group, baseline, truth });
      }
    }
  };

  // --- 混合音: 合成 A〜I ---------------------------------------------------
  for (const id of ["a", "b", "c", "d", "e", "f", "g", "h", "i"]) {
    const wav = readWav16(join(PROJECT_ROOT, "test-audio", `song-${id}.wav`));
    const truth = groundTruthSegs(
      join(PROJECT_ROOT, "test-audio", `song-${id}.groundtruth.json`),
    );
    const baseline = await analyzeAudio(wav.samples, wav.sampleRate, `song-${id}.wav`, undefined, {
      candidateRecord: true,
    });
    const off = await analyzeAudio(wav.samples, wav.sampleRate, `song-${id}.wav`, undefined, {
      candidateRecord: true,
      theoryReevaluationV2: false,
    });
    const reeval = await analyzeAudio(wav.samples, wav.sampleRate, `song-${id}.wav`, undefined, {
      candidateRecord: true,
      theoryReevaluationV2: true,
    });
    register(
      checkSuite(`mixture-synth-${id}`, "mixture", { baseline, off, reeval }, truth, false),
      "mixture-synth",
      baseline,
      truth,
    );
  }

  // --- 混合音・ステム: 実曲 1〜3 ＋ Song D stems ---------------------------
  for (const spec of STEM_SONGS) {
    const mix = loadAudioFile(spec.mixPath);
    const isD = spec.slug === "song-d";
    const truth = isD ? groundTruthSegs(spec.truthPath) : realTruthSegs(spec.truthPath);
    if (!isD) {
      const baseline = await analyzeAudio(mix.samples, mix.sampleRate, spec.slug, undefined, {
        candidateRecord: true,
      });
      const off = await analyzeAudio(mix.samples, mix.sampleRate, spec.slug, undefined, {
        candidateRecord: true,
        theoryReevaluationV2: false,
      });
      const reeval = await analyzeAudio(mix.samples, mix.sampleRate, spec.slug, undefined, {
        candidateRecord: true,
        theoryReevaluationV2: true,
      });
      register(
        checkSuite(`mixture-real-${spec.slug}`, "mixture", { baseline, off, reeval }, truth, false),
        "mixture-real",
        baseline,
        truth,
      );
    }
    const otherPath = findStemWav(spec.stemRoot, "other");
    const bassPath = findStemWav(spec.stemRoot, "bass");
    if (!otherPath || !bassPath) continue;
    const other = loadAudioFile(otherPath);
    const bass = loadAudioFile(bassPath);
    const chromas = prepareStemChromas(mix.samples, other.samples, bass.samples, mix.sampleRate);
    const baseline = analyzeStemsWithStrategy(chromas, chromas.sampleRate, spec.slug, "s-conditional", {
      candidateRecord: true,
    });
    const off = analyzeStemsWithStrategy(chromas, chromas.sampleRate, spec.slug, "s-conditional", {
      candidateRecord: true,
      theoryReevaluationV2: false,
    });
    const reeval = analyzeStemsWithStrategy(chromas, chromas.sampleRate, spec.slug, "s-conditional", {
      candidateRecord: true,
      theoryReevaluationV2: true,
    });
    register(
      checkSuite(`stems-${spec.slug}`, "stems", { baseline, off, reeval }, truth, false),
      isD ? "stems-song-d" : "stems-real",
      baseline,
      truth,
    );
  }

  // --- Suno 05: 両経路（フィクスチャ） -------------------------------------
  const mix05 = loadAudioFile(join(homedir(), "workspace/user/files/05.mp3"));
  {
    const baseline = await analyzeAudio(mix05.samples, mix05.sampleRate, "05.mp3", undefined, {
      candidateRecord: true,
    });
    const off = await analyzeAudio(mix05.samples, mix05.sampleRate, "05.mp3", undefined, {
      candidateRecord: true,
      theoryReevaluationV2: false,
    });
    const reeval = await analyzeAudio(mix05.samples, mix05.sampleRate, "05.mp3", undefined, {
      candidateRecord: true,
      theoryReevaluationV2: true,
    });
    suites.push(
      checkSuite("mixture-suno05", "mixture", { baseline, off, reeval }, null, true),
    );
    fixtureBaselines.push({ suite: "mixture-suno05", baseline });
  }
  {
    const stemRoot = join(PROJECT_ROOT, "stem-work/suno-05");
    const otherPath = findStemWav(stemRoot, "other");
    const bassPath = findStemWav(stemRoot, "bass");
    if (otherPath && bassPath) {
      const other = loadAudioFile(otherPath);
      const bass = loadAudioFile(bassPath);
      const input = {
        mixSamples: mix05.samples,
        otherSamples: other.samples,
        bassSamples: bass.samples,
        sampleRate: mix05.sampleRate,
        fileName: "05.mp3",
      };
      const baseline = await analyzeStemsAudio(input, undefined, { candidateRecord: true });
      const off = await analyzeStemsAudio(input, undefined, {
        candidateRecord: true,
        theoryReevaluationV2: false,
      });
      const reeval = await analyzeStemsAudio(input, undefined, {
        candidateRecord: true,
        theoryReevaluationV2: true,
      });
      suites.push(
        checkSuite("stems-suno05", "stems", { baseline, off, reeval }, null, true),
      );
      fixtureBaselines.push({ suite: "stems-suno05", baseline });
    }
  }

  // --- 宵のひかり アーム B（Demucs、フィクスチャ） ---------------------------
  if (sunoYoiReady()) {
    const work = join(PROJECT_ROOT, "stem-work/suno-yoi");
    const mix44 = readWav16(join(work, "mix44.wav"));
    const input = {
      mixSamples: mix44.samples,
      otherSamples: readWav16(join(work, "htdemucs/mix/other.wav")).samples,
      bassSamples: readWav16(join(work, "htdemucs/mix/bass.wav")).samples,
      sampleRate: mix44.sampleRate,
      fileName: "yoi-b.wav",
    };
    const baseline = await analyzeStemsAudio(input, undefined, { candidateRecord: true });
    const off = await analyzeStemsAudio(input, undefined, {
      candidateRecord: true,
      theoryReevaluationV2: false,
    });
    const reeval = await analyzeStemsAudio(input, undefined, {
      candidateRecord: true,
      theoryReevaluationV2: true,
    });
    suites.push(
      checkSuite("yoi-arm-b-demucs", "stems", { baseline, off, reeval }, null, true),
    );
    fixtureBaselines.push({ suite: "yoi-arm-b-demucs", baseline });
  }

  // --- 柱の ablation（baseline への純粋関数適用） ----------------------------
  for (const { group, baseline, truth } of ablationInputs) {
    for (const [name, w] of Object.entries(ABLATION_VARIANTS)) {
      addCoverage(
        ablations[name][group],
        coverageVsTruth(truth, asTop1(applyPure(baseline, w)), "labeled"),
      );
    }
  }
  const fixtureAblations: Record<string, FixtureLabelShare[]> = {};
  for (const name of Object.keys(ABLATION_VARIANTS)) {
    for (const { suite, baseline } of fixtureBaselines) {
      fixtureAblations[`${name}:${suite}`] = fixtureShares(
        baseline,
        applyPure(baseline, ABLATION_VARIANTS[name]),
      );
    }
  }

  // --- 初回保存値との一致確認 ------------------------------------------------
  let baselineMaxDev = 0;
  let v1MaxDev = 0;
  try {
    const step2 = JSON.parse(readFileSync(STEP2_PATH, "utf-8")) as {
      aggregates: Record<string, { baseline: CoverageAcc; reeval: CoverageAcc }>;
    };
    for (const g of ["mixture-synth", "mixture-real", "stems-real", "stems-song-d"]) {
      const prev = step2.aggregates[g];
      if (!prev) continue;
      const pb = coverageShares(prev.baseline);
      const pr = coverageShares(prev.reeval);
      const cb = coverageShares(aggBase[g]);
      const cv = coverageShares(aggV1[g]);
      for (const lvl of ["root", "triad", "core"] as const) {
        baselineMaxDev = Math.max(baselineMaxDev, Math.abs(pb[lvl][0] - cb[lvl][0]));
        v1MaxDev = Math.max(v1MaxDev, Math.abs(pr[lvl][0] - cv[lvl][0]));
      }
    }
  } catch {
    baselineMaxDev = Number.NaN;
    v1MaxDev = Number.NaN;
  }

  const aggregates: TheoryStep2RetryResults["aggregates"] = {};
  for (const g of groups) {
    aggregates[g] = { baseline: aggBase[g], reeval: aggRe[g], reevalV1: aggV1[g] };
  }

  const results: TheoryStep2RetryResults = {
    generatedAt: new Date().toISOString(),
    weights: THEORY_WEIGHTS_V2,
    suites,
    aggregates,
    ablations,
    fixtureAblations,
    step2Consistency: { baselineMaxDev, v1MaxDev },
    totals: {
      offInvariantSuites: suites.filter((s) => s.offInvariant).length,
      totalSuites: suites.length,
      ncDeltaMaxSec: Math.max(
        0,
        ...suites.map((s) => Math.abs(s.ncReevalSec - s.ncBaselineSec)),
      ),
    },
  };

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_PATH, `${JSON.stringify(results, null, 2)}\n`);
  return results;
}

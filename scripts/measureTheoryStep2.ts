/**
 * Theory Engine 第2段（最小の系列再評価器）の測定ハーネス。
 *
 * 測るもの（measurements/theory/THEORY_ENGINE_STEP2.md の事前登録基準）:
 * 1. 非劣性: 合成 A〜I 混合音・Song D ステムの root／triad Δ
 * 2. 改善: 実曲 1〜3（混合音・ステム別）の root／triad／core Δ
 * 3. フィクスチャ関門: Q3-B7 の悪化なし、Q2 の Cm 復活なし、
 *    Q1 の C/D・Q4 の C 読みの維持
 * 4. Song D 混合音の triad Δ
 * 5. 不変性: theoryReevaluation OFF が第1段と一致すること、
 *    N.C. 時間の変動ゼロ
 * あわせて反転の内訳（修正秒／破壊秒）と感度変種（合否には使わない）、
 * 参考として集計 argmax のみの精度（emission 設計の診断）を記録する。
 *
 * 実行: npm run measure:theory-step2（vitest 経由）
 * 結果: measurements/theory/theory-step2-results.json
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
import { readWav16 } from "./wav";

const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT_DIR = join(PROJECT_ROOT, "measurements", "theory");
const OUT_PATH = join(OUT_DIR, "theory-step2-results.json");
const STEP = 0.05;

function addCoverage(acc: CoverageAcc, other: CoverageAcc) {
  acc.denom += other.denom;
  acc.denomTriad += other.denomTriad;
  acc.ncSec += other.ncSec;
  other.root.forEach((v, i) => (acc.root[i] += v));
  other.triad.forEach((v, i) => (acc.triad[i] += v));
  other.core.forEach((v, i) => (acc.core[i] += v));
}

// ---------------------------------------------------------------------------
// 再評価後の top-1 を coverageVsTruth で測れる形にする
// ---------------------------------------------------------------------------

/** セグメントの確定ラベルだけを候補（単独）として持つ結果に変換する */
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

/** 参考診断: 集計 argmax（候補スコア最大）だけを top-1 にした結果 */
function asAggregateArgmax(result: AnalysisResult): AnalysisResult {
  return {
    ...result,
    segments: result.segments.map((s) => {
      if (s.chord === NO_CHORD || !s.candidates || s.candidates.length === 0) {
        return s;
      }
      const best = s.candidates.reduce((a, b) => (b.score > a.score ? b : a));
      return {
        ...s,
        candidates: [{ root: best.root, mode: best.mode, score: 0, margin: 0 }],
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// 反転の内訳（標本ベース）
// ---------------------------------------------------------------------------

export interface FlipBreakdown {
  flippedSegments: number;
  /** 反転セグメントのうち中点の正解（triad）と一致した数／正解なし */
  flippedSegTruthMatch: number;
  flippedSegTruthMiss: number;
  flippedSegNoTruth: number;
  /** triad レベルの秒: 誤り→正解（修正） */
  fixedSec: number;
  /** triad レベルの秒: 正解→誤り（破壊） */
  brokenSec: number;
  /** triad レベルの秒: 誤り→別の誤り */
  changedWrongSec: number;
  /** root レベルの秒: 修正／破壊 */
  fixedRootSec: number;
  brokenRootSec: number;
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

export function flipBreakdown(
  truth: TruthSeg[],
  baseline: AnalysisResult,
  reeval: AnalysisResult,
): FlipBreakdown {
  const out: FlipBreakdown = {
    flippedSegments: 0,
    flippedSegTruthMatch: 0,
    flippedSegTruthMiss: 0,
    flippedSegNoTruth: 0,
    fixedSec: 0,
    brokenSec: 0,
    changedWrongSec: 0,
    fixedRootSec: 0,
    brokenRootSec: 0,
  };
  const flippedIdx = new Set<number>();
  reeval.segments.forEach((s, i) => {
    if (s.chord !== baseline.segments[i]?.chord) {
      out.flippedSegments++;
      flippedIdx.add(i);
    }
  });
  // 反転セグメントの中点での正解一致
  for (const i of flippedIdx) {
    const s = reeval.segments[i];
    const mid = (s.start + s.end) / 2;
    const gt = truth.find((t) => mid >= t.start && mid < t.end);
    const p = parseChordName(s.chord);
    if (!gt || !p || gt.coreMode === null) out.flippedSegNoTruth++;
    else if (p.root === gt.root && p.mode === gt.coreMode) out.flippedSegTruthMatch++;
    else out.flippedSegTruthMiss++;
  }
  const duration = truth.length > 0 ? truth[truth.length - 1].end : 0;
  let ti = 0;
  for (let t = 0; t < duration; t += STEP) {
    const mid = t + STEP / 2;
    while (ti < truth.length - 1 && mid >= truth[ti].end) ti++;
    const gt = truth[ti] && mid >= truth[ti].start && mid < truth[ti].end ? truth[ti] : null;
    if (!gt) continue;
    const b = labelAt(baseline.segments, mid);
    const r = labelAt(reeval.segments, mid);
    if (!b || !r) continue; // labeled 基準（両者とも N.C. 状態は不変）
    const bRoot = b.root === gt.root;
    const rRoot = r.root === gt.root;
    if (!bRoot && rRoot) out.fixedRootSec += STEP;
    if (bRoot && !rRoot) out.brokenRootSec += STEP;
    if (gt.coreMode === null) continue;
    const bTri = bRoot && b.mode === gt.coreMode;
    const rTri = rRoot && r.mode === gt.coreMode;
    if (!bTri && rTri) out.fixedSec += STEP;
    else if (bTri && !rTri) out.brokenSec += STEP;
    else if (!bTri && !rTri && (b.root !== r.root || b.mode !== r.mode)) {
      out.changedWrongSec += STEP;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// フィクスチャ（ラベル時間割合）
// ---------------------------------------------------------------------------

export interface FixtureLabelShare {
  name: string;
  negative: boolean;
  /** 決着した読み（否定窓では Cm）のラベル時間割合: baseline / reeval */
  baseline: number;
  reeval: number;
  bassBaseline?: number;
  bassReeval?: number;
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

export interface SuiteStep2 {
  suite: string;
  path: "mixture" | "stems";
  /** theoryReevaluation OFF（明示 false）が baseline と完全一致したか */
  offInvariant: boolean;
  ncBaselineSec: number;
  ncReevalSec: number;
  baseline: CoverageAcc | null;
  reeval: CoverageAcc | null;
  flips: FlipBreakdown | null;
  fixtures?: FixtureLabelShare[];
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
): SuiteStep2 {
  const ncSec = (r: AnalysisResult) =>
    r.segments
      .filter((s) => s.chord === NO_CHORD)
      .reduce((a, s) => a + (s.end - s.start), 0);
  return {
    suite,
    path,
    offInvariant: labelSignature(trio.baseline) === labelSignature(trio.off),
    ncBaselineSec: ncSec(trio.baseline),
    ncReevalSec: ncSec(trio.reeval),
    baseline: truth ? coverageVsTruth(truth, trio.baseline, "labeled") : null,
    reeval: truth ? coverageVsTruth(truth, asTop1(trio.reeval), "labeled") : null,
    flips: truth ? flipBreakdown(truth, trio.baseline, trio.reeval) : null,
    ...(withFixtures
      ? { fixtures: fixtureShares(trio.baseline, trio.reeval) }
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

// 感度変種（合否には使わない。baseline のセグメント列へ純粋関数で適用）。
// emission-flat は主構成の判定確定後に追加した探索変種: 主構成の敗因が
// emission の逓減尾（集計への過度な追従）にあるという分析を切り分ける
// ためのもので、主構成の合否は変えない（STEP2.md §4.3）。
export const SENSITIVITY_VARIANTS: Record<string, TheoryWeights> = {
  "cap-half": {
    key: THEORY_WEIGHTS.key / 2,
    diatonic: THEORY_WEIGHTS.diatonic / 2,
    transition: THEORY_WEIGHTS.transition / 2,
    emissionClamp: THEORY_WEIGHTS.emissionClamp / 2,
    swingCap: THEORY_WEIGHTS.swingCap / 2,
    emissionTail: THEORY_WEIGHTS.emissionTail,
    emissionFloorAtZero: false,
  },
  "cap-double": {
    key: THEORY_WEIGHTS.key * 2,
    diatonic: THEORY_WEIGHTS.diatonic * 2,
    transition: THEORY_WEIGHTS.transition * 2,
    emissionClamp: THEORY_WEIGHTS.emissionClamp * 2,
    swingCap: THEORY_WEIGHTS.swingCap * 2,
    emissionTail: THEORY_WEIGHTS.emissionTail,
    emissionFloorAtZero: false,
  },
  "transitions-only": {
    key: 0,
    diatonic: 0,
    transition: THEORY_WEIGHTS.transition * 2,
    emissionClamp: THEORY_WEIGHTS.emissionClamp,
    swingCap: THEORY_WEIGHTS.swingCap,
    emissionTail: THEORY_WEIGHTS.emissionTail,
    emissionFloorAtZero: false,
  },
  "nodes-only": {
    key: THEORY_WEIGHTS.key * 2,
    diatonic: THEORY_WEIGHTS.diatonic * 2,
    transition: 0,
    emissionClamp: THEORY_WEIGHTS.emissionClamp,
    swingCap: THEORY_WEIGHTS.swingCap,
    emissionTail: THEORY_WEIGHTS.emissionTail,
    emissionFloorAtZero: false,
  },
  "emission-flat": {
    key: THEORY_WEIGHTS.key,
    diatonic: THEORY_WEIGHTS.diatonic,
    transition: THEORY_WEIGHTS.transition,
    emissionClamp: THEORY_WEIGHTS.emissionClamp,
    swingCap: THEORY_WEIGHTS.swingCap,
    emissionTail: 0,
    emissionFloorAtZero: false,
  },
  // 探索変種2: 負マージンを emission 0 に切り捨てる（STEP2.md §4.3）
  "emission-floored": {
    key: THEORY_WEIGHTS.key,
    diatonic: THEORY_WEIGHTS.diatonic,
    transition: THEORY_WEIGHTS.transition,
    emissionClamp: THEORY_WEIGHTS.emissionClamp,
    swingCap: THEORY_WEIGHTS.swingCap,
    emissionTail: 0,
    emissionFloorAtZero: true,
  },
};

export interface TheoryStep2Results {
  generatedAt: string;
  weights: TheoryWeights;
  suites: SuiteStep2[];
  aggregates: Record<
    string,
    { baseline: CoverageAcc; reeval: CoverageAcc }
  >;
  /** 感度変種の集計被覆（k=1 = top-1 相当） */
  sensitivity: Record<string, Record<string, CoverageAcc>>;
  /** 探索変種 emission-flat のフィクスチャ挙動（合否には使わない） */
  fixtureVariants: Record<string, FixtureLabelShare[]>;
  /** 参考診断: 集計 argmax のみの被覆（実曲集計） */
  aggregateArgmax: Record<string, CoverageAcc>;
  totals: {
    offInvariantSuites: number;
    totalSuites: number;
    ncDeltaMaxSec: number;
  };
}

export async function runTheoryStep2Measurement(): Promise<TheoryStep2Results> {
  const suites: SuiteStep2[] = [];
  const aggBase: Record<string, CoverageAcc> = {
    "mixture-synth": newCoverageAcc(),
    "mixture-real": newCoverageAcc(),
    "stems-real": newCoverageAcc(),
  };
  const aggRe: Record<string, CoverageAcc> = {
    "mixture-synth": newCoverageAcc(),
    "mixture-real": newCoverageAcc(),
    "stems-real": newCoverageAcc(),
  };
  const argmaxAcc: Record<string, CoverageAcc> = {
    "mixture-real": newCoverageAcc(),
    "stems-real": newCoverageAcc(),
  };
  const sensitivity: Record<string, Record<string, CoverageAcc>> = {};
  for (const name of Object.keys(SENSITIVITY_VARIANTS)) {
    sensitivity[name] = {
      "mixture-synth": newCoverageAcc(),
      "mixture-real": newCoverageAcc(),
      "stems-real": newCoverageAcc(),
    };
  }
  // 感度変種の適用対象（baseline 結果と正解のペア）を貯める
  const variantInputs: {
    group: string;
    baseline: AnalysisResult;
    truth: TruthSeg[];
  }[] = [];

  const register = (
    outcome: SuiteStep2,
    group: string | null,
    baseline: AnalysisResult,
    truth: TruthSeg[] | null,
  ) => {
    suites.push(outcome);
    if (group && truth && outcome.baseline && outcome.reeval) {
      addCoverage(aggBase[group], outcome.baseline);
      addCoverage(aggRe[group], outcome.reeval);
      variantInputs.push({ group, baseline, truth });
      if (group === "mixture-real" || group === "stems-real") {
        addCoverage(
          argmaxAcc[group],
          coverageVsTruth(truth, asAggregateArgmax(baseline), "labeled"),
        );
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
      theoryReevaluation: false,
    });
    const reeval = await analyzeAudio(wav.samples, wav.sampleRate, `song-${id}.wav`, undefined, {
      candidateRecord: true,
      theoryReevaluation: true,
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
        theoryReevaluation: false,
      });
      const reeval = await analyzeAudio(mix.samples, mix.sampleRate, spec.slug, undefined, {
        candidateRecord: true,
        theoryReevaluation: true,
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
      theoryReevaluation: false,
    });
    const reeval = analyzeStemsWithStrategy(chromas, chromas.sampleRate, spec.slug, "s-conditional", {
      candidateRecord: true,
      theoryReevaluation: true,
    });
    register(
      checkSuite(`stems-${spec.slug}`, "stems", { baseline, off, reeval }, truth, false),
      isD ? null : "stems-real",
      baseline,
      truth,
    );
    if (isD) {
      // Song D ステムは基準1の個別対象として集計にも入れる
      const outcome = suites[suites.length - 1];
      if (outcome.baseline && outcome.reeval) {
        (aggBase["stems-song-d"] ??= newCoverageAcc());
        (aggRe["stems-song-d"] ??= newCoverageAcc());
        addCoverage(aggBase["stems-song-d"], outcome.baseline);
        addCoverage(aggRe["stems-song-d"], outcome.reeval);
      }
    }
  }

  // --- Suno 05: 両経路（フィクスチャ） -------------------------------------
  const fixtureBaselines: { suite: string; baseline: AnalysisResult }[] = [];
  const mix05 = loadAudioFile(join(homedir(), "workspace/user/files/05.mp3"));
  {
    const baseline = await analyzeAudio(mix05.samples, mix05.sampleRate, "05.mp3", undefined, {
      candidateRecord: true,
    });
    const off = await analyzeAudio(mix05.samples, mix05.sampleRate, "05.mp3", undefined, {
      candidateRecord: true,
      theoryReevaluation: false,
    });
    const reeval = await analyzeAudio(mix05.samples, mix05.sampleRate, "05.mp3", undefined, {
      candidateRecord: true,
      theoryReevaluation: true,
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
        theoryReevaluation: false,
      });
      const reeval = await analyzeStemsAudio(input, undefined, {
        candidateRecord: true,
        theoryReevaluation: true,
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
      theoryReevaluation: false,
    });
    const reeval = await analyzeStemsAudio(input, undefined, {
      candidateRecord: true,
      theoryReevaluation: true,
    });
    suites.push(
      checkSuite("yoi-arm-b-demucs", "stems", { baseline, off, reeval }, null, true),
    );
    fixtureBaselines.push({ suite: "yoi-arm-b-demucs", baseline });
  }

  // --- 感度変種（baseline への純粋関数適用） --------------------------------
  for (const { group, baseline, truth } of variantInputs) {
    for (const [name, w] of Object.entries(SENSITIVITY_VARIANTS)) {
      const re = applyTheoryReevaluation(
        baseline.segments,
        {
          keyRoot: baseline.keyRoot,
          keyMode: baseline.keyMode,
          ...(baseline.localKeys ? { localKeys: baseline.localKeys } : {}),
        },
        w,
      );
      addCoverage(
        sensitivity[name][group],
        coverageVsTruth(truth, asTop1({ ...baseline, segments: re }), "labeled"),
      );
    }
  }

  // --- 探索変種のフィクスチャ挙動 ------------------------------------------
  const fixtureVariants: TheoryStep2Results["fixtureVariants"] = {};
  for (const variantName of ["emission-flat", "emission-floored"]) {
    for (const { suite, baseline } of fixtureBaselines) {
      const re = applyTheoryReevaluation(
        baseline.segments,
        {
          keyRoot: baseline.keyRoot,
          keyMode: baseline.keyMode,
          ...(baseline.localKeys ? { localKeys: baseline.localKeys } : {}),
        },
        SENSITIVITY_VARIANTS[variantName],
      );
      fixtureVariants[`${variantName}:${suite}`] = fixtureShares(baseline, {
        ...baseline,
        segments: re,
      });
    }
  }

  const aggregates: TheoryStep2Results["aggregates"] = {};
  for (const g of Object.keys(aggBase)) {
    aggregates[g] = { baseline: aggBase[g], reeval: aggRe[g] };
  }

  const results: TheoryStep2Results = {
    generatedAt: new Date().toISOString(),
    weights: THEORY_WEIGHTS,
    suites,
    aggregates,
    sensitivity,
    fixtureVariants,
    aggregateArgmax: argmaxAcc,
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

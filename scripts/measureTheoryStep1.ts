/**
 * Theory Engine 第1段（候補リストの露出）の測定ハーネス。
 *
 * 測るもの（measurements/theory/THEORY_ENGINE_STEP1.md の事前登録基準）:
 * 1. 不変性: candidateRecord OFF/ON で判定結果（ラベル列・キー・BPM）が
 *    完全一致すること（スイート横断で直接比較する）。
 * 2. 整合性: 露出候補の1位が確定ラベル（root / mode / bassPc）と常に
 *    一致すること。代替候補の順序性（スコア降順）とマージン定義、
 *    N.C. 候補の形状も同時に検査する。
 * 3. オラクル被覆率（副次測定）: 正解ラベルが上位 k 候補内に存在する
 *    時間割合（root / triad / core、k=1,2,3,5、経路別）。
 *    これは再評価器が到達可能な上限（天井）の測定であり、精度改善の
 *    主張ではない。
 *
 * 実行: npm run measure:theory-step1（vitest 経由）
 * 結果: measurements/theory/theory-step1-results.json
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeAudio, DEFAULT_CHORD_BAND } from "../src/analysis/analyze";
import {
  analyzeStemsAudio,
  analyzeStemsWithStrategy,
  prepareStemChromas,
} from "../src/analysis/analyzeStems";
import { parseChordName } from "../src/analysis/bassCorrection";
import { attachSegmentCandidates } from "../src/analysis/candidates";
import { computeChromagram } from "../src/dsp/chroma";
import { NO_CHORD } from "../src/lib/notes";
import type { AnalysisResult, ChordSegment } from "../src/types";
import { loadAudioFile, parseTruthChord, parseTruthJson } from "./measureReal";
import { findStemWav, STEM_SONGS } from "./measureStems";
import { sunoYoiReady } from "./measureSunoYoi";
import { readWav16 } from "./wav";

const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT_DIR = join(PROJECT_ROOT, "measurements", "theory");
const OUT_PATH = join(OUT_DIR, "theory-step1-results.json");

export const KS = [1, 2, 3, 5] as const;
const STEP = 0.05;

// ---------------------------------------------------------------------------
// 整合性・不変性チェック
// ---------------------------------------------------------------------------

/** 候補を除いた判定結果の署名（OFF/ON 比較用） */
export function labelSignature(result: AnalysisResult): string {
  return JSON.stringify({
    keyName: result.keyName,
    bpm: result.bpm,
    segments: result.segments.map(({ candidates: _c, ...rest }) => rest),
  });
}

/** 候補リストの整合性違反を列挙する（空 = 合格） */
export function consistencyViolations(result: AnalysisResult): string[] {
  const out: string[] = [];
  for (const seg of result.segments) {
    const at = `${seg.start.toFixed(2)}s ${seg.chord}`;
    const cands = seg.candidates;
    if (!cands) {
      out.push(`${at}: candidates が無い`);
      continue;
    }
    if (cands.length === 0) {
      out.push(`${at}: candidates が空`);
      continue;
    }
    if (cands[0].margin !== 0) out.push(`${at}: 1位の margin が 0 でない`);
    const parsed = seg.chord === NO_CHORD ? null : parseChordName(seg.chord);
    if (parsed) {
      if (cands[0].root !== parsed.root || cands[0].mode !== parsed.mode) {
        out.push(
          `${at}: 1位 (${cands[0].root}/${cands[0].mode}) が確定ラベルと不一致`,
        );
      }
      if (cands[0].bassPc !== seg.bassPc) {
        out.push(`${at}: 1位の bassPc がセグメントと不一致`);
      }
    }
    for (let i = 0; i < cands.length; i++) {
      const c = cands[i];
      if (Math.abs(c.margin - (cands[0].score - c.score)) > 1e-9) {
        out.push(`${at}: 候補${i} の margin が定義（1位との差）と不一致`);
      }
      if (c.bassPc !== seg.bassPc) {
        out.push(`${at}: 候補${i} の bassPc がセグメントと不一致`);
      }
      if (i >= 2 && c.score > cands[i - 1].score + 1e-12) {
        out.push(`${at}: 代替候補がスコア降順でない`);
      }
      if (!parsed && c.margin < -1e-12) {
        out.push(`${at}: N.C. 候補の margin が負`);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// オラクル被覆率
// ---------------------------------------------------------------------------

export interface TruthSeg {
  start: number;
  end: number;
  root: number;
  /** 三和音コアのモード。定まらない場合（sus 等）は null */
  coreMode: "major" | "minor" | null;
}

export interface CoverageAcc {
  /** 分母（秒）: root / core レベル */
  denom: number;
  /** 分母（秒）: triad レベル（coreMode が定まる標本のみ） */
  denomTriad: number;
  /** レベル×k の被覆秒（KS と同じ並び） */
  root: number[];
  triad: number[];
  core: number[];
  /** 検出が N.C. だった秒（labeled 基準の分母から外れた量の記録） */
  ncSec: number;
}

export function newCoverageAcc(): CoverageAcc {
  return {
    denom: 0,
    denomTriad: 0,
    root: KS.map(() => 0),
    triad: KS.map(() => 0),
    core: KS.map(() => 0),
    ncSec: 0,
  };
}

function addCoverage(acc: CoverageAcc, other: CoverageAcc) {
  acc.denom += other.denom;
  acc.denomTriad += other.denomTriad;
  acc.ncSec += other.ncSec;
  KS.forEach((_, i) => {
    acc.root[i] += other.root[i];
    acc.triad[i] += other.triad[i];
    acc.core[i] += other.core[i];
  });
}

/**
 * 正解に対する被覆を標本単位で数える。
 * basis "labeled": 検出がラベルありの標本だけを分母にする（見出し値）。
 * basis "all": 全標本を分母にし、N.C. 標本は棄却候補の列で判定する。
 */
export function coverageVsTruth(
  truth: TruthSeg[],
  result: AnalysisResult,
  basis: "labeled" | "all",
): CoverageAcc {
  const acc = newCoverageAcc();
  const duration = truth.length > 0 ? truth[truth.length - 1].end : 0;
  let ti = 0;
  let di = 0;
  const segs = result.segments;
  for (let t = 0; t < duration; t += STEP) {
    const mid = t + STEP / 2;
    while (ti < truth.length - 1 && mid >= truth[ti].end) ti++;
    const gt = truth[ti] && mid >= truth[ti].start && mid < truth[ti].end
      ? truth[ti]
      : null;
    if (!gt) continue;
    while (di < segs.length - 1 && mid >= segs[di].end) di++;
    const det = segs[di] && mid >= segs[di].start && mid < segs[di].end
      ? segs[di]
      : null;
    const detNc = !det || det.chord === NO_CHORD;
    if (detNc) acc.ncSec += STEP;
    if (basis === "labeled" && detNc) continue;
    acc.denom += STEP;
    if (gt.coreMode !== null) acc.denomTriad += STEP;
    const cands = det?.candidates ?? [];
    KS.forEach((k, ki) => {
      const top = cands.slice(0, k);
      if (top.some((c) => c.root === gt.root)) acc.root[ki] += STEP;
      if (
        gt.coreMode !== null &&
        top.some((c) => c.root === gt.root && c.mode === gt.coreMode)
      ) {
        acc.triad[ki] += STEP;
      }
      if (
        top.some(
          (c) =>
            c.root === gt.root &&
            (gt.coreMode === null || c.mode === gt.coreMode),
        )
      ) {
        acc.core[ki] += STEP;
      }
    });
  }
  return acc;
}

export function coverageShares(acc: CoverageAcc): {
  root: number[];
  triad: number[];
  core: number[];
} {
  const div = (xs: number[], d: number) =>
    xs.map((x) => (d > 0 ? x / d : 0));
  return {
    root: div(acc.root, acc.denom),
    triad: div(acc.triad, acc.denomTriad),
    core: div(acc.core, acc.denom),
  };
}

// ---------------------------------------------------------------------------
// Suno フィクスチャ被覆（決着済み読みに対する候補内存在率）
// ---------------------------------------------------------------------------

export interface FixtureWindow {
  name: string;
  range: [number, number];
  /** 決着した三和音の読み。null は否定フィクスチャ（存在しない方が良い） */
  settled: { root: number; mode: "major" | "minor" } | null;
  /** 決着したベース音（層表示の分母側）。無ければチェックしない */
  settledBassPc?: number;
  negative?: boolean;
}

export const SUNO_FIXTURE_WINDOWS: FixtureWindow[] = [
  { name: "Q1a (0:51-0:56)", range: [51, 56], settled: { root: 0, mode: "major" }, settledBassPc: 2 },
  { name: "Q1b (1:33-1:38)", range: [93, 98], settled: { root: 0, mode: "major" }, settledBassPc: 2 },
  { name: "Q4 (1:02-1:05)", range: [62, 65], settled: { root: 0, mode: "major" }, settledBassPc: 1 },
  { name: "Q3-C (1:25-1:27)", range: [85, 87], settled: { root: 0, mode: "major" } },
  { name: "Q3-B7 (1:27-1:29)", range: [87, 89], settled: { root: 11, mode: "major" } },
  { name: "Q3-E7 (1:29-1:31)", range: [89, 91], settled: { root: 4, mode: "major" } },
  { name: "Q3-Am (1:31-1:33)", range: [91, 93], settled: { root: 9, mode: "minor" } },
  { name: "Q2 (2:33-2:48, Cm 棄却)", range: [153, 168], settled: { root: 0, mode: "minor" }, negative: true },
];

export interface FixtureCoverage {
  name: string;
  negative: boolean;
  /** 決着した読みが top-k 内にある時間割合（KS 並び）。否定窓では Cm の存在率 */
  inTopK: number[];
  /** settledBassPc がある窓のみ: その標本のセグメントの bassPc 一致率 */
  bassMatch?: number;
}

export function fixtureCoverage(
  result: AnalysisResult,
  win: FixtureWindow,
): FixtureCoverage {
  const [lo, hi] = win.range;
  const counts = KS.map(() => 0);
  let total = 0;
  let bassOk = 0;
  let di = 0;
  const segs = result.segments;
  for (let t = lo; t < hi; t += STEP) {
    const mid = t + STEP / 2;
    while (di < segs.length - 1 && mid >= segs[di].end) di++;
    const det = segs[di] && mid >= segs[di].start && mid < segs[di].end
      ? segs[di]
      : null;
    total += STEP;
    if (win.settledBassPc !== undefined && det && det.bassPc === win.settledBassPc) {
      bassOk += STEP;
    }
    const cands = det?.candidates ?? [];
    KS.forEach((k, ki) => {
      if (
        win.settled &&
        cands
          .slice(0, k)
          .some((c) => c.root === win.settled!.root && c.mode === win.settled!.mode)
      ) {
        counts[ki] += STEP;
      }
    });
  }
  return {
    name: win.name,
    negative: win.negative === true,
    inTopK: counts.map((c) => (total > 0 ? c / total : 0)),
    ...(win.settledBassPc !== undefined
      ? { bassMatch: total > 0 ? bassOk / total : 0 }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// スイート実行
// ---------------------------------------------------------------------------

export interface SuiteOutcome {
  suite: string;
  path: "mixture" | "stems";
  /** OFF/ON で判定結果が完全一致したか */
  invariant: boolean;
  violations: string[];
  labeled: CoverageAcc;
  all: CoverageAcc;
  fixtures?: FixtureCoverage[];
}

interface RunPair {
  off: AnalysisResult;
  on: AnalysisResult;
}

function checkPair(
  suite: string,
  path: "mixture" | "stems",
  { off, on }: RunPair,
  truth: TruthSeg[] | null,
  withFixtures: boolean,
): SuiteOutcome {
  return {
    suite,
    path,
    invariant: labelSignature(off) === labelSignature(on),
    violations: consistencyViolations(on),
    labeled: truth ? coverageVsTruth(truth, on, "labeled") : newCoverageAcc(),
    all: truth ? coverageVsTruth(truth, on, "all") : newCoverageAcc(),
    ...(withFixtures
      ? { fixtures: SUNO_FIXTURE_WINDOWS.map((w) => fixtureCoverage(on, w)) }
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

export interface TheoryStep1Results {
  generatedAt: string;
  suites: SuiteOutcome[];
  aggregates: Record<string, { labeled: CoverageAcc; all: CoverageAcc }>;
  /** 参考: 全帯域集計で候補を作った場合の被覆（出荷しない定義との比較） */
  fullBandReference: Record<string, CoverageAcc>;
  totals: {
    invariantSuites: number;
    totalSuites: number;
    violationCount: number;
  };
}

export async function runTheoryStep1Measurement(): Promise<TheoryStep1Results> {
  const suites: SuiteOutcome[] = [];
  const fullBandReference: Record<string, CoverageAcc> = {};

  // --- 混合音: 合成 A〜I -------------------------------------------------
  const mixSynthLabeled = newCoverageAcc();
  const mixSynthAll = newCoverageAcc();
  const mixSynthFullBand = newCoverageAcc();
  for (const id of ["a", "b", "c", "d", "e", "f", "g", "h", "i"]) {
    const wav = readWav16(join(PROJECT_ROOT, "test-audio", `song-${id}.wav`));
    const truth = groundTruthSegs(
      join(PROJECT_ROOT, "test-audio", `song-${id}.groundtruth.json`),
    );
    const off = await analyzeAudio(wav.samples, wav.sampleRate, `song-${id}.wav`);
    const on = await analyzeAudio(wav.samples, wav.sampleRate, `song-${id}.wav`, undefined, {
      candidateRecord: true,
    });
    const outcome = checkPair(`mixture-synth-${id}`, "mixture", { off, on }, truth, false);
    suites.push(outcome);
    addCoverage(mixSynthLabeled, outcome.labeled);
    addCoverage(mixSynthAll, outcome.all);
    // 参考: 全帯域集計の候補での被覆（同じ確定セグメント列に付け替える）
    const chroma = computeChromagram(wav.samples, wav.sampleRate, undefined, {
      chordBand: DEFAULT_CHORD_BAND,
    });
    const fullBandSegs = attachSegmentCandidates(on.segments, {
      frames: chroma.frames,
      energies: chroma.energies,
      frameDuration: chroma.frameDuration,
    });
    addCoverage(
      mixSynthFullBand,
      coverageVsTruth(truth, { ...on, segments: fullBandSegs }, "labeled"),
    );
  }
  fullBandReference["mixture-synth"] = mixSynthFullBand;

  // --- 混合音: 実曲 1〜3 --------------------------------------------------
  const mixRealLabeled = newCoverageAcc();
  const mixRealAll = newCoverageAcc();
  const mixRealFullBand = newCoverageAcc();
  for (const spec of STEM_SONGS.filter((s) => s.slug !== "song-d")) {
    const mix = loadAudioFile(spec.mixPath);
    const truth = realTruthSegs(spec.truthPath);
    const off = await analyzeAudio(mix.samples, mix.sampleRate, spec.slug);
    const on = await analyzeAudio(mix.samples, mix.sampleRate, spec.slug, undefined, {
      candidateRecord: true,
    });
    const outcome = checkPair(`mixture-real-${spec.slug}`, "mixture", { off, on }, truth, false);
    suites.push(outcome);
    addCoverage(mixRealLabeled, outcome.labeled);
    addCoverage(mixRealAll, outcome.all);
    const chroma = computeChromagram(mix.samples, mix.sampleRate, undefined, {
      chordBand: DEFAULT_CHORD_BAND,
    });
    const fullBandSegs = attachSegmentCandidates(on.segments, {
      frames: chroma.frames,
      energies: chroma.energies,
      frameDuration: chroma.frameDuration,
    });
    addCoverage(
      mixRealFullBand,
      coverageVsTruth(truth, { ...on, segments: fullBandSegs }, "labeled"),
    );
  }
  fullBandReference["mixture-real"] = mixRealFullBand;

  // --- ステム: 実曲 1〜3 ＋ Song D ---------------------------------------
  const stemsRealLabeled = newCoverageAcc();
  const stemsRealAll = newCoverageAcc();
  for (const spec of STEM_SONGS) {
    const mix = loadAudioFile(spec.mixPath);
    const otherPath = findStemWav(spec.stemRoot, "other");
    const bassPath = findStemWav(spec.stemRoot, "bass");
    if (!otherPath || !bassPath) continue;
    const other = loadAudioFile(otherPath);
    const bass = loadAudioFile(bassPath);
    const chromas = prepareStemChromas(mix.samples, other.samples, bass.samples, mix.sampleRate);
    const off = analyzeStemsWithStrategy(chromas, chromas.sampleRate, spec.slug, "s-conditional");
    const on = analyzeStemsWithStrategy(chromas, chromas.sampleRate, spec.slug, "s-conditional", {
      candidateRecord: true,
    });
    const truth =
      spec.slug === "song-d"
        ? groundTruthSegs(spec.truthPath)
        : realTruthSegs(spec.truthPath);
    const outcome = checkPair(`stems-${spec.slug}`, "stems", { off, on }, truth, false);
    suites.push(outcome);
    // 集計（stems-real）は実曲 1〜3 のみ。Song D は個別スイートとして残す
    if (spec.slug !== "song-d") {
      addCoverage(stemsRealLabeled, outcome.labeled);
      addCoverage(stemsRealAll, outcome.all);
    }
  }

  // --- Suno 05: 両経路（フィクスチャのみ） --------------------------------
  const mix05 = loadAudioFile(join(homedir(), "workspace/user/files/05.mp3"));
  {
    const off = await analyzeAudio(mix05.samples, mix05.sampleRate, "05.mp3");
    const on = await analyzeAudio(mix05.samples, mix05.sampleRate, "05.mp3", undefined, {
      candidateRecord: true,
    });
    suites.push(checkPair("mixture-suno05", "mixture", { off, on }, null, true));
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
      const off = await analyzeStemsAudio(input);
      const on = await analyzeStemsAudio(input, undefined, { candidateRecord: true });
      suites.push(checkPair("stems-suno05", "stems", { off, on }, null, true));
    }
  }

  // --- 宵のひかり各アーム（フィクスチャのみ） ------------------------------
  if (sunoYoiReady()) {
    const work = join(PROJECT_ROOT, "stem-work/suno-yoi");
    const mix44 = readWav16(join(work, "mix44.wav"));
    const mix48 = readWav16(join(work, "mix.wav"));
    {
      const off = await analyzeAudio(mix44.samples, mix44.sampleRate, "yoi-a44.wav");
      const on = await analyzeAudio(mix44.samples, mix44.sampleRate, "yoi-a44.wav", undefined, {
        candidateRecord: true,
      });
      suites.push(checkPair("yoi-arm-a44-mixture", "mixture", { off, on }, null, true));
    }
    const demucs = {
      other: readWav16(join(work, "htdemucs/mix/other.wav")),
      bass: readWav16(join(work, "htdemucs/mix/bass.wav")),
    };
    const stemArms: { name: string; input: Parameters<typeof analyzeStemsAudio>[0] }[] = [
      {
        name: "yoi-arm-b-demucs",
        input: {
          mixSamples: mix44.samples,
          otherSamples: demucs.other.samples,
          bassSamples: demucs.bass.samples,
          sampleRate: mix44.sampleRate,
          fileName: "yoi-b.wav",
        },
      },
      {
        name: "yoi-arm-c-suno-stems",
        input: {
          mixSamples: mix48.samples,
          otherSamples: readWav16(join(work, "other_suno.wav")).samples,
          bassSamples: readWav16(join(work, "src/bass.wav")).samples,
          sampleRate: mix48.sampleRate,
          fileName: "yoi-c.wav",
        },
      },
      {
        name: "yoi-arm-c44-suno-stems",
        input: {
          mixSamples: mix44.samples,
          otherSamples: readWav16(join(work, "other_suno44.wav")).samples,
          bassSamples: readWav16(join(work, "bass44.wav")).samples,
          sampleRate: mix44.sampleRate,
          fileName: "yoi-c44.wav",
        },
      },
    ];
    for (const arm of stemArms) {
      const off = await analyzeStemsAudio(arm.input);
      const on = await analyzeStemsAudio(arm.input, undefined, { candidateRecord: true });
      suites.push(checkPair(arm.name, "stems", { off, on }, null, true));
    }
  }

  const results: TheoryStep1Results = {
    generatedAt: new Date().toISOString(),
    suites,
    aggregates: {
      "mixture-synth": { labeled: mixSynthLabeled, all: mixSynthAll },
      "mixture-real": { labeled: mixRealLabeled, all: mixRealAll },
      "stems-real": { labeled: stemsRealLabeled, all: stemsRealAll },
    },
    fullBandReference,
    totals: {
      invariantSuites: suites.filter((s) => s.invariant).length,
      totalSuites: suites.length,
      violationCount: suites.reduce((n, s) => n + s.violations.length, 0),
    },
  };

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_PATH, `${JSON.stringify(results, null, 2)}\n`);
  return results;
}

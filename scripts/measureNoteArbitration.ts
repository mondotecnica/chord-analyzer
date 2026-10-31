/**
 * 音符仲裁を主軸にした再評価器の測定ハーネス。
 *
 * 測るもの（measurements/theory/THEORY_ENGINE_NOTE_ARBITRATION.md
 * の事前登録基準）:
 * 1. 非劣性: 合成 A〜I 混合音・Song D ステムの root／triad Δ
 * 2. 改善（経路別）: 実曲 1〜3（混合音・ステム別）の
 *    root／triad／core Δ と反転内訳
 * 3. フィクスチャ関門: Q3-Am 保全（独立項目 3a）、Q3-B7 の回復
 *    フロア、Q2 の Cm 非復活、Q1／Q4 の維持、Q3-C／E7 の悪化なし
 * 4. Song D 混合音の triad Δ
 * 5. 不変性: noteArbitration OFF／音符入力なし ON が baseline と
 *    一致すること、N.C. 変動ゼロ、baseline と v1 の挙動が初回
 *    保存値（theory-step2-results.json）と一致すること
 * あわせて反転の駆動源内訳（notes／theory）と、理論補助 OFF の
 * ablation（合否には使わない）を記録する。再評価は baseline
 * （candidateRecord のみ）への純粋関数適用で測り、製品接続
 * （noteEvidence + noteArbitration の実経路）とのラベル一致を
 * 3 スイートでスポット確認する。
 *
 * 実行: npm run measure:note-arbitration（vitest 経由）
 * 結果: measurements/theory/theory-note-arbitration-results.json
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
import type { NoteEvent } from "../src/analysis/noteEvidence";
import {
  applyNoteArbitration,
  NOTE_ARBITRATION_CONFIG,
  type NoteArbitrationConfig,
} from "../src/analysis/noteArbitration";
import {
  applyTheoryReevaluation,
  THEORY_WEIGHTS,
} from "../src/analysis/theoryReevaluation";
import { NO_CHORD } from "../src/lib/notes";
import type { AnalysisResult, ChordSegment } from "../src/types";
import { loadAudioFile, parseTruthChord, parseTruthJson } from "./measureReal";
import { findStemWav, STEM_SONGS } from "./measureStems";
import { sunoYoiReady } from "./measureSunoYoi";
import { loadNotes } from "./measureNoteIntegration";
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
const OUT_PATH = join(OUT_DIR, "theory-note-arbitration-results.json");
const STEP2_PATH = join(OUT_DIR, "theory-step2-results.json");
const STEP = 0.05;

/** 理論補助 OFF の ablation 構成（合否には使わない） */
export const NO_THEORY_CONFIG: NoteArbitrationConfig = {
  ...NOTE_ARBITRATION_CONFIG,
  theoryAssist: false,
};

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
  notes: NoteEvent[] | null,
  config: NoteArbitrationConfig = NOTE_ARBITRATION_CONFIG,
): AnalysisResult {
  if (!notes) return baseline;
  return {
    ...baseline,
    segments: applyNoteArbitration(
      baseline.segments,
      { harmony: notes },
      profileOf(baseline),
      config,
    ),
  };
}

function applyV1(baseline: AnalysisResult): AnalysisResult {
  return {
    ...baseline,
    segments: applyTheoryReevaluation(baseline.segments, profileOf(baseline), THEORY_WEIGHTS),
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
// 反転の駆動源内訳
// ---------------------------------------------------------------------------

export interface FlipSourceBreakdown {
  notesSegments: number;
  notesSec: number;
  theorySegments: number;
  theorySec: number;
}

function flipSources(
  baseline: AnalysisResult,
  reeval: AnalysisResult,
): FlipSourceBreakdown {
  const out: FlipSourceBreakdown = {
    notesSegments: 0,
    notesSec: 0,
    theorySegments: 0,
    theorySec: 0,
  };
  reeval.segments.forEach((s, i) => {
    if (s.chord === baseline.segments[i]?.chord) return;
    const r = s.noteArbitrationRationale;
    const dur = s.end - s.start;
    if (r?.source === "theory") {
      out.theorySegments++;
      out.theorySec += dur;
    } else {
      out.notesSegments++;
      out.notesSec += dur;
    }
  });
  return out;
}

// ---------------------------------------------------------------------------
// スイート実行
// ---------------------------------------------------------------------------

export interface SuiteNoteArbitration {
  suite: string;
  path: "mixture" | "stems";
  /** 音符キャッシュがあり評価器へ入力できたか */
  notesAvailable: boolean;
  offInvariant: boolean;
  noNotesInvariant: boolean;
  ncBaselineSec: number;
  ncReevalSec: number;
  baseline: CoverageAcc | null;
  reeval: CoverageAcc | null;
  ablation: CoverageAcc | null;
  flips: FlipBreakdown | null;
  flipsAblation: FlipBreakdown | null;
  sources: FlipSourceBreakdown;
  fixtures?: FixtureLabelShare[];
  fixturesAblation?: FixtureLabelShare[];
}

interface Runs {
  baseline: AnalysisResult;
  off: AnalysisResult;
  noNotes: AnalysisResult;
}

function checkSuite(
  suite: string,
  path: "mixture" | "stems",
  runs: Runs,
  notes: NoteEvent[] | null,
  truth: TruthSeg[] | null,
  withFixtures: boolean,
): SuiteNoteArbitration {
  const ncSec = (r: AnalysisResult) =>
    r.segments
      .filter((s) => s.chord === NO_CHORD)
      .reduce((a, s) => a + (s.end - s.start), 0);
  const reeval = applyPure(runs.baseline, notes);
  const ablation = applyPure(runs.baseline, notes, NO_THEORY_CONFIG);
  return {
    suite,
    path,
    notesAvailable: notes !== null,
    offInvariant: labelSignature(runs.baseline) === labelSignature(runs.off),
    noNotesInvariant:
      labelSignature(runs.baseline) === labelSignature(runs.noNotes),
    ncBaselineSec: ncSec(runs.baseline),
    ncReevalSec: ncSec(reeval),
    baseline: truth ? coverageVsTruth(truth, runs.baseline, "labeled") : null,
    reeval: truth ? coverageVsTruth(truth, asTop1(reeval), "labeled") : null,
    ablation: truth ? coverageVsTruth(truth, asTop1(ablation), "labeled") : null,
    flips: truth ? flipBreakdown(truth, runs.baseline, reeval) : null,
    flipsAblation: truth ? flipBreakdown(truth, runs.baseline, ablation) : null,
    sources: flipSources(runs.baseline, reeval),
    ...(withFixtures
      ? {
          fixtures: fixtureShares(runs.baseline, reeval),
          fixturesAblation: fixtureShares(runs.baseline, ablation),
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

const labelSeq = (r: AnalysisResult) => r.segments.map((s) => s.chord);

export interface NoteArbitrationResults {
  generatedAt: string;
  config: NoteArbitrationConfig;
  suites: SuiteNoteArbitration[];
  aggregates: Record<
    string,
    { baseline: CoverageAcc; reeval: CoverageAcc; ablation: CoverageAcc }
  >;
  /** 初回保存値との一致確認（baseline／v1 の集計 k=1 シェアの最大偏差） */
  step2Consistency: { baselineMaxDev: number; v1MaxDev: number };
  /** 製品接続（実経路）と純粋関数適用のラベル一致（スポット確認） */
  wiringChecks: { suite: string; labelsMatch: boolean }[];
  totals: {
    offInvariantSuites: number;
    noNotesInvariantSuites: number;
    totalSuites: number;
    ncDeltaMaxSec: number;
  };
}

export async function runNoteArbitrationMeasurement(): Promise<NoteArbitrationResults> {
  const suites: SuiteNoteArbitration[] = [];
  const groups = ["mixture-synth", "mixture-real", "stems-real", "stems-song-d"];
  const aggBase: Record<string, CoverageAcc> = {};
  const aggRe: Record<string, CoverageAcc> = {};
  const aggAb: Record<string, CoverageAcc> = {};
  const aggV1: Record<string, CoverageAcc> = {};
  for (const g of groups) {
    aggBase[g] = newCoverageAcc();
    aggRe[g] = newCoverageAcc();
    aggAb[g] = newCoverageAcc();
    aggV1[g] = newCoverageAcc();
  }
  const wiringChecks: NoteArbitrationResults["wiringChecks"] = [];

  const register = (
    outcome: SuiteNoteArbitration,
    group: string | null,
    baseline: AnalysisResult,
    truth: TruthSeg[] | null,
  ) => {
    suites.push(outcome);
    if (group && truth && outcome.baseline && outcome.reeval && outcome.ablation) {
      addCoverage(aggBase[group], outcome.baseline);
      addCoverage(aggRe[group], outcome.reeval);
      addCoverage(aggAb[group], outcome.ablation);
      addCoverage(aggV1[group], coverageVsTruth(truth, asTop1(applyV1(baseline)), "labeled"));
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
      noteArbitration: false,
    });
    const noNotes = await analyzeAudio(wav.samples, wav.sampleRate, `song-${id}.wav`, undefined, {
      candidateRecord: true,
      noteArbitration: true,
    });
    const notes = loadNotes(`song-${id}.bp.json`);
    register(
      checkSuite(`mixture-synth-${id}`, "mixture", { baseline, off, noNotes }, notes, truth, false),
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
        noteArbitration: false,
      });
      const noNotes = await analyzeAudio(mix.samples, mix.sampleRate, spec.slug, undefined, {
        candidateRecord: true,
        noteArbitration: true,
      });
      const notes = loadNotes(`${spec.slug}-mix.bp.json`);
      register(
        checkSuite(`mixture-real-${spec.slug}`, "mixture", { baseline, off, noNotes }, notes, truth, false),
        "mixture-real",
        baseline,
        truth,
      );
      // 製品接続のスポット確認（実曲1の混合音だけ）
      if (spec.slug === STEM_SONGS.find((s) => s.slug !== "song-d")!.slug) {
        const wired = await analyzeAudio(mix.samples, mix.sampleRate, spec.slug, undefined, {
          candidateRecord: true,
          noteArbitration: true,
          noteEvidence: { harmony: notes },
        });
        wiringChecks.push({
          suite: `mixture-real-${spec.slug}`,
          labelsMatch:
            JSON.stringify(labelSeq(wired)) ===
            JSON.stringify(labelSeq(applyPure(baseline, notes))),
        });
      }
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
      noteArbitration: false,
    });
    const noNotes = analyzeStemsWithStrategy(chromas, chromas.sampleRate, spec.slug, "s-conditional", {
      candidateRecord: true,
      noteArbitration: true,
    });
    // Song D ステムには other の音符キャッシュが無い（無動作の見込み）
    const notes = isD ? null : loadNotes(`${spec.slug}-other.bp.json`);
    register(
      checkSuite(`stems-${spec.slug}`, "stems", { baseline, off, noNotes }, notes, truth, false),
      isD ? "stems-song-d" : "stems-real",
      baseline,
      truth,
    );
  }

  // --- Suno 05: 両経路（フィクスチャ） -------------------------------------
  const mix05 = loadAudioFile(join(homedir(), "workspace/user/files/05.mp3"));
  {
    const notes = loadNotes("suno05-mix.bp.json");
    const baseline = await analyzeAudio(mix05.samples, mix05.sampleRate, "05.mp3", undefined, {
      candidateRecord: true,
    });
    const off = await analyzeAudio(mix05.samples, mix05.sampleRate, "05.mp3", undefined, {
      candidateRecord: true,
      noteArbitration: false,
    });
    const noNotes = await analyzeAudio(mix05.samples, mix05.sampleRate, "05.mp3", undefined, {
      candidateRecord: true,
      noteArbitration: true,
    });
    suites.push(
      checkSuite("mixture-suno05", "mixture", { baseline, off, noNotes }, notes, null, true),
    );
    const wired = await analyzeAudio(mix05.samples, mix05.sampleRate, "05.mp3", undefined, {
      candidateRecord: true,
      noteArbitration: true,
      noteEvidence: { harmony: notes },
    });
    wiringChecks.push({
      suite: "mixture-suno05",
      labelsMatch:
        JSON.stringify(labelSeq(wired)) ===
        JSON.stringify(labelSeq(applyPure(baseline, notes))),
    });
  }
  {
    const stemRoot = join(PROJECT_ROOT, "stem-work/suno-05");
    const otherPath = findStemWav(stemRoot, "other");
    const bassPath = findStemWav(stemRoot, "bass");
    if (otherPath && bassPath) {
      const notes = loadNotes("suno05-other.bp.json");
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
        noteArbitration: false,
      });
      const noNotes = await analyzeStemsAudio(input, undefined, {
        candidateRecord: true,
        noteArbitration: true,
      });
      suites.push(
        checkSuite("stems-suno05", "stems", { baseline, off, noNotes }, notes, null, true),
      );
      const wired = await analyzeStemsAudio(input, undefined, {
        noteArbitration: true,
        noteEvidence: {
          harmony: notes,
          bass: loadNotes("suno05-bass.bp.json"),
        },
      });
      wiringChecks.push({
        suite: "stems-suno05",
        labelsMatch:
          JSON.stringify(labelSeq(wired)) ===
          JSON.stringify(labelSeq(applyPure(baseline, notes))),
      });
    }
  }

  // --- 宵のひかり アーム B（Demucs、フィクスチャ。音符キャッシュなし） -----
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
      noteArbitration: false,
    });
    const noNotes = await analyzeStemsAudio(input, undefined, {
      candidateRecord: true,
      noteArbitration: true,
    });
    suites.push(
      checkSuite("yoi-arm-b-demucs", "stems", { baseline, off, noNotes }, null, null, true),
    );
  }

  // --- 初回保存値との一致確認 ------------------------------------------------
  let baselineMaxDev = 0;
  let v1MaxDev = 0;
  try {
    const step2 = JSON.parse(readFileSync(STEP2_PATH, "utf-8")) as {
      aggregates: Record<string, { baseline: CoverageAcc; reeval: CoverageAcc }>;
    };
    for (const g of groups) {
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

  const aggregates: NoteArbitrationResults["aggregates"] = {};
  for (const g of groups) {
    aggregates[g] = { baseline: aggBase[g], reeval: aggRe[g], ablation: aggAb[g] };
  }

  const results: NoteArbitrationResults = {
    generatedAt: new Date().toISOString(),
    config: NOTE_ARBITRATION_CONFIG,
    suites,
    aggregates,
    step2Consistency: { baselineMaxDev, v1MaxDev },
    wiringChecks,
    totals: {
      offInvariantSuites: suites.filter((s) => s.offInvariant).length,
      noNotesInvariantSuites: suites.filter((s) => s.noNotesInvariant).length,
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

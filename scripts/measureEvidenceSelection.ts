/**
 * 音符レベルの証拠選択の診断測定ハーネス
 * （measurements/notepitch/EVIDENCE_SELECTION.md の事前登録に対応）。
 *
 * 測るもの:
 * A. 証拠の純度: 4条件（原音符／持続のみ／メロディ分離のみ／両方）
 *    で、証拠のピッチクラス重みが正解三和音の構成音にどれだけ
 *    集中するかを、実曲 1〜3（両経路）と Suno フィクスチャで比較。
 * B. 仲裁診断: 第1段候補で勝者と上帯域集計 argmax が割れている
 *    セグメントについて、二択を各証拠源に委ねたときの正解率。
 *    Theory Engine 再開条件（第三の証拠の成立）の判定に使う。
 *
 * 実行: npm run measure:evidence-selection（vitest 経由）
 * 結果: measurements/notepitch/evidence-selection-results.json
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeAudio } from "../src/analysis/analyze";
import {
  analyzeStemsWithStrategy,
  prepareStemChromas,
} from "../src/analysis/analyzeStems";
import { parseChordName } from "../src/analysis/bassCorrection";
import {
  triadExplained,
  type NoteEvent,
} from "../src/analysis/noteEvidence";
import {
  classifyMelodyNotes,
  segmentSelectedWeights,
  NOTE_SELECTION_CONFIG,
  type NoteSelectionOptions,
} from "../src/analysis/noteEvidenceSelection";
import { NO_CHORD } from "../src/lib/notes";
import type { AnalysisResult, ChordSegment } from "../src/types";
import { loadAudioFile, parseTruthChord, parseTruthJson } from "./measureReal";
import { findStemWav, STEM_SONGS } from "./measureStems";
import { loadNotes } from "./measureNoteIntegration";
import {
  SUNO_FIXTURE_WINDOWS,
  type TruthSeg,
} from "./measureTheoryStep1";

const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT_DIR = join(PROJECT_ROOT, "measurements", "notepitch");
const OUT_PATH = join(OUT_DIR, "evidence-selection-results.json");
const STEP = 0.05;

const CONDITIONS = [
  { id: "raw", options: { sustainWeighting: false, melodySeparation: false } },
  { id: "sustain", options: { sustainWeighting: true, melodySeparation: false } },
  { id: "melody", options: { sustainWeighting: false, melodySeparation: true } },
  { id: "both", options: { sustainWeighting: true, melodySeparation: true } },
] as const;
type ConditionId = (typeof CONDITIONS)[number]["id"];
const CONDITION_IDS = CONDITIONS.map((c) => c.id) as ConditionId[];

function optionsOf(id: ConditionId): NoteSelectionOptions {
  return CONDITIONS.find((c) => c.id === id)!.options;
}

// ---------------------------------------------------------------------------
// ユーティリティ
// ---------------------------------------------------------------------------

/** 片側二項検定 P(X ≥ x | n, p=0.5) */
export function binomialUpperTail(x: number, n: number): number {
  if (n <= 0) return 1;
  let pmf = Math.pow(0.5, n);
  let tail = 0;
  for (let k = 0; k <= n; k++) {
    if (k >= x) tail += pmf;
    pmf = (pmf * (n - k)) / (k + 1);
  }
  return Math.min(1, tail);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

function realTruthSegs(path: string): TruthSeg[] {
  const truth = parseTruthJson(
    JSON.parse(readFileSync(path, "utf-8")),
    path,
  );
  return truth.segments.flatMap((s) => {
    const p = parseTruthChord(s.chord);
    return p
      ? [{ start: s.startSec, end: s.endSec, root: p.root, coreMode: p.coreMode }]
      : [];
  });
}

interface SegmentWeights {
  /** 条件 id → セグメントごとのピッチクラス重み（null = 証拠なし） */
  byCondition: Record<ConditionId, (Float32Array | null)[]>;
  /** 条件 id → フォールバックが発動したセグメント数 */
  fallbacks: Record<ConditionId, number>;
}

function computeSegmentWeights(
  segments: ChordSegment[],
  notes: NoteEvent[],
): SegmentWeights {
  const mask = classifyMelodyNotes(notes);
  const byCondition = {} as SegmentWeights["byCondition"];
  const fallbacks = {} as SegmentWeights["fallbacks"];
  for (const cond of CONDITIONS) {
    byCondition[cond.id] = segments.map((seg) => {
      const { weights, provenance } = segmentSelectedWeights(
        notes,
        mask,
        seg.start,
        seg.end,
        cond.options,
      );
      if (provenance.fallback) {
        fallbacks[cond.id] = (fallbacks[cond.id] ?? 0) + 1;
      }
      return weights;
    });
    fallbacks[cond.id] = fallbacks[cond.id] ?? 0;
  }
  return { byCondition, fallbacks };
}

// ---------------------------------------------------------------------------
// 診断 A: 純度（実曲）
// ---------------------------------------------------------------------------

export interface PurityAcc {
  /** 条件 id → 純度の時間加重和と分母（秒） */
  sum: Record<ConditionId, number>;
  denomSec: Record<ConditionId, number>;
  /** 正解の coreMode が定まらず分母から外した秒数 */
  truthModeUnknownSec: number;
  /** 検出セグメントが無い標本の秒数 */
  noSegmentSec: number;
}

function newPurityAcc(): PurityAcc {
  const rec = () => Object.fromEntries(CONDITION_IDS.map((id) => [id, 0])) as Record<ConditionId, number>;
  return { sum: rec(), denomSec: rec(), truthModeUnknownSec: 0, noSegmentSec: 0 };
}

function purityVsTruth(
  truth: TruthSeg[],
  result: AnalysisResult,
  weights: SegmentWeights,
): PurityAcc {
  const acc = newPurityAcc();
  const duration = truth.length > 0 ? truth[truth.length - 1].end : 0;
  const segs = result.segments;
  let ti = 0;
  let di = 0;
  for (let t = 0; t < duration; t += STEP) {
    const mid = t + STEP / 2;
    while (ti < truth.length - 1 && mid >= truth[ti].end) ti++;
    const gt =
      truth[ti] && mid >= truth[ti].start && mid < truth[ti].end ? truth[ti] : null;
    if (!gt) continue;
    if (gt.coreMode === null) {
      acc.truthModeUnknownSec += STEP;
      continue;
    }
    while (di < segs.length - 1 && mid >= segs[di].end) di++;
    const detIdx =
      segs[di] && mid >= segs[di].start && mid < segs[di].end ? di : -1;
    if (detIdx < 0) {
      acc.noSegmentSec += STEP;
      continue;
    }
    for (const id of CONDITION_IDS) {
      const w = weights.byCondition[id][detIdx];
      if (!w) continue;
      acc.sum[id] += triadExplained(w, gt.root, gt.coreMode) * STEP;
      acc.denomSec[id] += STEP;
    }
  }
  return acc;
}

function addPurity(a: PurityAcc, b: PurityAcc) {
  for (const id of CONDITION_IDS) {
    a.sum[id] += b.sum[id];
    a.denomSec[id] += b.denomSec[id];
  }
  a.truthModeUnknownSec += b.truthModeUnknownSec;
  a.noSegmentSec += b.noSegmentSec;
}

function purityReport(acc: PurityAcc): Record<ConditionId, { purity: number; denomSec: number }> {
  const out = {} as Record<ConditionId, { purity: number; denomSec: number }>;
  for (const id of CONDITION_IDS) {
    out[id] = {
      purity: acc.denomSec[id] > 0 ? acc.sum[id] / acc.denomSec[id] : 0,
      denomSec: acc.denomSec[id],
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// 診断 B: 仲裁
// ---------------------------------------------------------------------------

const SOURCE_IDS = ["aggregate", "raw", "sustain", "melody", "both"] as const;
type SourceId = (typeof SOURCE_IDS)[number];

export interface ArbitrationAcc {
  /** 勝者と argmax が割れているセグメント数 */
  disagreementSegments: number;
  /** 割れているセグメントの総秒数 */
  disagreementSec: number;
  /** 仲裁可能な標本（正解がちょうど一方と一致）の秒数 */
  arbitrableSec: number;
  /** 正解が両方と一致／両方と不一致で仲裁対象外になった秒数 */
  nonArbitrableSec: number;
  /** 証拠源ごとの正解秒・分母秒・棄権秒 */
  sources: Record<SourceId, { correctSec: number; denomSec: number; abstainSec: number }>;
  /** 二項検定用（選択済み証拠のみ）: 対象セグメント数と正解数 */
  binomialSegments: number;
  binomialCorrect: number;
}

function newArbitrationAcc(): ArbitrationAcc {
  const sources = {} as ArbitrationAcc["sources"];
  for (const id of SOURCE_IDS) sources[id] = { correctSec: 0, denomSec: 0, abstainSec: 0 };
  return {
    disagreementSegments: 0,
    disagreementSec: 0,
    arbitrableSec: 0,
    nonArbitrableSec: 0,
    sources,
    binomialSegments: 0,
    binomialCorrect: 0,
  };
}

function addArbitration(a: ArbitrationAcc, b: ArbitrationAcc) {
  a.disagreementSegments += b.disagreementSegments;
  a.disagreementSec += b.disagreementSec;
  a.arbitrableSec += b.arbitrableSec;
  a.nonArbitrableSec += b.nonArbitrableSec;
  for (const id of SOURCE_IDS) {
    a.sources[id].correctSec += b.sources[id].correctSec;
    a.sources[id].denomSec += b.sources[id].denomSec;
    a.sources[id].abstainSec += b.sources[id].abstainSec;
  }
  a.binomialSegments += b.binomialSegments;
  a.binomialCorrect += b.binomialCorrect;
}

type TriadKey = { root: number; mode: "major" | "minor" };
const sameTriad = (a: TriadKey, b: TriadKey) => a.root === b.root && a.mode === b.mode;

function arbitrationVsTruth(
  truth: TruthSeg[],
  result: AnalysisResult,
  weights: SegmentWeights,
): ArbitrationAcc {
  const acc = newArbitrationAcc();
  const segs = result.segments;
  for (let si = 0; si < segs.length; si++) {
    const seg = segs[si];
    const cands = seg.candidates;
    if (!cands || cands.length === 0) continue;
    const winner: TriadKey = { root: cands[0].root, mode: cands[0].mode };
    let argmax = cands[0];
    for (const c of cands) if (c.score > argmax.score) argmax = c;
    const argmaxKey: TriadKey = { root: argmax.root, mode: argmax.mode };
    if (sameTriad(winner, argmaxKey)) continue;
    acc.disagreementSegments++;
    acc.disagreementSec += seg.end - seg.start;

    // 証拠源ごとの票（セグメント単位）
    const picks = {} as Record<SourceId, TriadKey | null>;
    picks.aggregate = argmaxKey;
    for (const id of CONDITION_IDS) {
      const w = weights.byCondition[id][si];
      if (!w) {
        picks[id] = null;
        continue;
      }
      const ew = triadExplained(w, winner.root, winner.mode);
      const ea = triadExplained(w, argmaxKey.root, argmaxKey.mode);
      picks[id] = ew > ea ? winner : ea > ew ? argmaxKey : null;
    }

    // セグメント内の仲裁可能な標本を数える
    let winnerTruthSec = 0;
    let argmaxTruthSec = 0;
    for (let t = seg.start; t < seg.end; t += STEP) {
      const mid = t + STEP / 2;
      if (mid >= seg.end) break;
      const gt = truth.find((g) => mid >= g.start && mid < g.end);
      if (!gt || gt.coreMode === null) continue;
      const gtKey: TriadKey = { root: gt.root, mode: gt.coreMode };
      const wMatch = sameTriad(gtKey, winner);
      const aMatch = sameTriad(gtKey, argmaxKey);
      if (wMatch && !aMatch) winnerTruthSec += STEP;
      else if (aMatch && !wMatch) argmaxTruthSec += STEP;
      else acc.nonArbitrableSec += STEP;
    }
    const arbitrable = winnerTruthSec + argmaxTruthSec;
    if (arbitrable <= 0) continue;
    acc.arbitrableSec += arbitrable;
    for (const id of SOURCE_IDS) {
      const pick = picks[id];
      if (!pick) {
        acc.sources[id].abstainSec += arbitrable;
        continue;
      }
      acc.sources[id].denomSec += arbitrable;
      acc.sources[id].correctSec += sameTriad(pick, winner)
        ? winnerTruthSec
        : argmaxTruthSec;
    }
    // 二項検定（選択済み証拠）: 仲裁可能 0.2 秒以上、正解側が確定
    if (arbitrable >= 0.2 && winnerTruthSec !== argmaxTruthSec) {
      const truthSide = winnerTruthSec > argmaxTruthSec ? winner : argmaxKey;
      const pick = picks.both;
      if (pick) {
        acc.binomialSegments++;
        if (sameTriad(pick, truthSide)) acc.binomialCorrect++;
      }
    }
  }
  return acc;
}

function arbitrationReport(acc: ArbitrationAcc) {
  const sources = {} as Record<SourceId, { accuracy: number; denomSec: number; abstainSec: number }>;
  for (const id of SOURCE_IDS) {
    const s = acc.sources[id];
    sources[id] = {
      accuracy: s.denomSec > 0 ? s.correctSec / s.denomSec : 0,
      denomSec: s.denomSec,
      abstainSec: s.abstainSec,
    };
  }
  return {
    disagreementSegments: acc.disagreementSegments,
    disagreementSec: acc.disagreementSec,
    arbitrableSec: acc.arbitrableSec,
    nonArbitrableSec: acc.nonArbitrableSec,
    sources,
    winnerBaselineAccuracy: 1 - sources.aggregate.accuracy,
    binomialBoth: {
      segments: acc.binomialSegments,
      correct: acc.binomialCorrect,
      accuracy: acc.binomialSegments > 0 ? acc.binomialCorrect / acc.binomialSegments : 0,
      pValue: binomialUpperTail(acc.binomialCorrect, acc.binomialSegments),
    },
  };
}

// ---------------------------------------------------------------------------
// スイート実行
// ---------------------------------------------------------------------------

export interface EvidenceSelectionResults {
  generatedAt: string;
  config: typeof NOTE_SELECTION_CONFIG;
  durationProbe: Record<string, { n: number; p25: number; median: number; p75: number; p90: number }>;
  purity: {
    realPerSong: { slug: string; path: string; conditions: ReturnType<typeof purityReport>; fallbacks: Record<ConditionId, number> }[];
    realPooledByPath: Record<string, ReturnType<typeof purityReport>>;
    sunoFixtures: {
      path: string;
      window: string;
      negative: boolean;
      /** 正の窓は決着三和音への純度、Q2 は Cm 三和音への重み割合 */
      values: Record<ConditionId, number | null>;
    }[];
  };
  arbitration: {
    perSong: { slug: string; path: string; report: ReturnType<typeof arbitrationReport> }[];
    perPath: Record<string, ReturnType<typeof arbitrationReport>>;
    pooled: ReturnType<typeof arbitrationReport>;
  };
  b7Window: Record<string, unknown>;
}

function probeDurations(name: string, notes: NoteEvent[], out: EvidenceSelectionResults["durationProbe"]) {
  const durs = notes.map((n) => n.end - n.start).sort((a, b) => a - b);
  out[name] = {
    n: durs.length,
    p25: percentile(durs, 0.25),
    median: percentile(durs, 0.5),
    p75: percentile(durs, 0.75),
    p90: percentile(durs, 0.9),
  };
}

export async function runEvidenceSelectionMeasurement(): Promise<EvidenceSelectionResults> {
  const durationProbe: EvidenceSelectionResults["durationProbe"] = {};
  const realPerSong: EvidenceSelectionResults["purity"]["realPerSong"] = [];
  const arbPerSong: EvidenceSelectionResults["arbitration"]["perSong"] = [];
  const pooledPurity: Record<string, PurityAcc> = { mixture: newPurityAcc(), stems: newPurityAcc() };
  const pooledArb: Record<string, ArbitrationAcc> = { mixture: newArbitrationAcc(), stems: newArbitrationAcc() };
  const totalArb = newArbitrationAcc();
  const sunoFixtures: EvidenceSelectionResults["purity"]["sunoFixtures"] = [];
  const b7Window: Record<string, unknown> = {};

  // --- 実曲 1〜3: 両経路 ---------------------------------------------------
  for (const spec of STEM_SONGS.filter((s) => s.slug !== "song-d")) {
    const truth = realTruthSegs(spec.truthPath);
    const mix = loadAudioFile(spec.mixPath);

    // 混合音経路
    {
      const notes = loadNotes(`${spec.slug}-mix.bp.json`);
      probeDurations(`${spec.slug}-mix`, notes, durationProbe);
      const result = await analyzeAudio(mix.samples, mix.sampleRate, spec.slug, undefined, {
        candidateRecord: true,
      });
      const weights = computeSegmentWeights(result.segments, notes);
      const purity = purityVsTruth(truth, result, weights);
      const arb = arbitrationVsTruth(truth, result, weights);
      addPurity(pooledPurity.mixture, purity);
      addArbitration(pooledArb.mixture, arb);
      addArbitration(totalArb, arb);
      realPerSong.push({
        slug: spec.slug,
        path: "mixture",
        conditions: purityReport(purity),
        fallbacks: weights.fallbacks,
      });
      arbPerSong.push({ slug: spec.slug, path: "mixture", report: arbitrationReport(arb) });
    }

    // ステム経路
    const otherPath = findStemWav(spec.stemRoot, "other");
    const bassPath = findStemWav(spec.stemRoot, "bass");
    if (otherPath && bassPath) {
      const notes = loadNotes(`${spec.slug}-other.bp.json`);
      probeDurations(`${spec.slug}-other`, notes, durationProbe);
      const other = loadAudioFile(otherPath);
      const bass = loadAudioFile(bassPath);
      const chromas = prepareStemChromas(mix.samples, other.samples, bass.samples, mix.sampleRate);
      const result = analyzeStemsWithStrategy(chromas, chromas.sampleRate, spec.slug, "s-conditional", {
        candidateRecord: true,
      });
      const weights = computeSegmentWeights(result.segments, notes);
      const purity = purityVsTruth(truth, result, weights);
      const arb = arbitrationVsTruth(truth, result, weights);
      addPurity(pooledPurity.stems, purity);
      addArbitration(pooledArb.stems, arb);
      addArbitration(totalArb, arb);
      realPerSong.push({
        slug: spec.slug,
        path: "stems",
        conditions: purityReport(purity),
        fallbacks: weights.fallbacks,
      });
      arbPerSong.push({ slug: spec.slug, path: "stems", report: arbitrationReport(arb) });
    }
  }

  // --- Suno 05: フィクスチャ純度と B7 窓 ----------------------------------
  const mix05 = loadAudioFile(join(homedir(), "workspace/user/files/05.mp3"));
  const sunoRuns: { path: "mixture" | "stems"; result: AnalysisResult; notes: NoteEvent[] }[] = [];
  {
    const notes = loadNotes("suno05-mix.bp.json");
    probeDurations("suno05-mix", notes, durationProbe);
    const result = await analyzeAudio(mix05.samples, mix05.sampleRate, "05.mp3", undefined, {
      candidateRecord: true,
    });
    sunoRuns.push({ path: "mixture", result, notes });
  }
  {
    const stemRoot = join(PROJECT_ROOT, "stem-work/suno-05");
    const otherPath = findStemWav(stemRoot, "other");
    const bassPath = findStemWav(stemRoot, "bass");
    if (otherPath && bassPath) {
      const notes = loadNotes("suno05-other.bp.json");
      probeDurations("suno05-other", notes, durationProbe);
      const other = loadAudioFile(otherPath);
      const bass = loadAudioFile(bassPath);
      const chromas = prepareStemChromas(mix05.samples, other.samples, bass.samples, mix05.sampleRate);
      const result = analyzeStemsWithStrategy(chromas, chromas.sampleRate, "05.mp3", "s-conditional", {
        candidateRecord: true,
      });
      sunoRuns.push({ path: "stems", result, notes });
    }
  }

  for (const run of sunoRuns) {
    const mask = classifyMelodyNotes(run.notes);
    for (const win of SUNO_FIXTURE_WINDOWS) {
      const [lo, hi] = win.range;
      const values = {} as Record<ConditionId, number | null>;
      for (const id of CONDITION_IDS) {
        const { weights } = segmentSelectedWeights(run.notes, mask, lo, hi, optionsOf(id));
        if (!weights || !win.settled) {
          values[id] = null;
          continue;
        }
        values[id] = triadExplained(weights, win.settled.root, win.settled.mode);
      }
      sunoFixtures.push({
        path: run.path,
        window: win.name,
        negative: win.negative === true,
        values,
      });
    }

    // B7 窓（87–89 秒）の個別報告
    const weights = computeSegmentWeights(run.result.segments, run.notes);
    const bTriad: TriadKey = { root: 11, mode: "major" };
    const segReports: Record<string, unknown>[] = [];
    run.result.segments.forEach((seg, si) => {
      if (seg.end <= 87 || seg.start >= 89) return;
      const parsed = seg.chord === NO_CHORD ? null : parseChordName(seg.chord);
      const cands = seg.candidates ?? [];
      let argmax = cands[0];
      for (const c of cands) if (argmax && c.score > argmax.score) argmax = c;
      const perCondition: Record<string, unknown> = {};
      for (const id of CONDITION_IDS) {
        const w = weights.byCondition[id][si];
        perCondition[id] = w
          ? {
              bMajor: triadExplained(w, bTriad.root, bTriad.mode),
              winner: parsed ? triadExplained(w, parsed.root, parsed.mode) : null,
              argmax: argmax
                ? triadExplained(w, argmax.root, argmax.mode)
                : null,
            }
          : null;
      }
      segReports.push({
        start: seg.start,
        end: seg.end,
        chord: seg.chord,
        argmax: argmax ? { root: argmax.root, mode: argmax.mode } : null,
        perCondition,
      });
    });
    // 窓全体の時間加重シェア（B vs 勝者ラベル）
    const windowShares: Record<string, { bMajor: number; winner: number }> = {};
    for (const id of CONDITION_IDS) {
      let bSum = 0;
      let wSum = 0;
      let denom = 0;
      run.result.segments.forEach((seg, si) => {
        const w = weights.byCondition[id][si];
        if (!w) return;
        const ov = Math.min(seg.end, 89) - Math.max(seg.start, 87);
        if (ov <= 0) return;
        const parsed = seg.chord === NO_CHORD ? null : parseChordName(seg.chord);
        bSum += triadExplained(w, bTriad.root, bTriad.mode) * ov;
        wSum += (parsed ? triadExplained(w, parsed.root, parsed.mode) : 0) * ov;
        denom += ov;
      });
      windowShares[id] = denom > 0 ? { bMajor: bSum / denom, winner: wSum / denom } : { bMajor: 0, winner: 0 };
    }
    b7Window[run.path] = { segments: segReports, windowShares };
  }

  const results: EvidenceSelectionResults = {
    generatedAt: new Date().toISOString(),
    config: NOTE_SELECTION_CONFIG,
    durationProbe,
    purity: {
      realPerSong,
      realPooledByPath: {
        mixture: purityReport(pooledPurity.mixture),
        stems: purityReport(pooledPurity.stems),
      },
      sunoFixtures,
    },
    arbitration: {
      perSong: arbPerSong,
      perPath: {
        mixture: arbitrationReport(pooledArb.mixture),
        stems: arbitrationReport(pooledArb.stems),
      },
      pooled: arbitrationReport(totalArb),
    },
    b7Window,
  };

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_PATH, `${JSON.stringify(results, null, 2)}\n`);
  return results;
}

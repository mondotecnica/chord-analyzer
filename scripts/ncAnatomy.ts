/**
 * N.C.（無判定）区間の解剖 — セグメント単位の原因分類。
 *
 * 背景: stems 経路で N.C. が増える（実曲1: 混合音 3.4% → stems 6.9%）うえ、
 * Suno 05 では stems 22.8%（混合音 5.2%）と突出している。Phase 3 では
 * N.C. を合格基準に入れなかったため、原因の内訳を測る仕組みが無い。
 * 本モジュールは「デフォルトのパイプラインが出した N.C. セグメント」を、
 * パイプライン内部の証拠（フレームエネルギー、テンプレート照合スコア、
 * ステム経路では混合音クロマと bass ステムの証拠）で次の4クラスに分類する:
 *
 * - "routing"（ステム経路のみ）: 判定材料の other ステムでは証拠が弱い／
 *   ゲートに落ちたが、混合音クロマの集計照合は明確なコードを示し、
 *   フレーム単位の最頻コードも過半で一致している。証拠の振り分けの問題。
 * - "low-energy": 判定経路のフレームの大半（>= 70%）が無音ゲート
 *   （エネルギー < 中央値×0.15）にかかっている。和声エネルギーが実際に
 *   薄い区間で、N.C. が正解である可能性が高い。
 * - "short": 0.7 秒未満の短い区間（境界の滲み・単発の落ち）。
 * - "score-gate": エネルギーはあるがフレーム単位の照合スコアが
 *   信頼ゲート（0.55）に届かなかった区間。セグメント集計照合の結果も
 *   併記する（集計でゲートを超えるなら「フレーム単位のノイズ」が原因）。
 *
 * 分類は上記の優先順（routing → low-energy → short → score-gate）で
 * 1 セグメント 1 クラスに決めるが、生の証拠フィールドは全て記録するので、
 * 別の切り口での再集計も可能。
 *
 * 正解がある曲では、各 N.C. セグメントが正解コードにどれだけ重なるか
 * （recoverable = 正解コードが区間の 50% 以上を占める）も記録する。
 * これは「介入で回収可能な N.C.」の上限の見積もりになる。
 */
import {
  CONFIDENCE_THRESHOLD,
  matchChord,
} from "../src/analysis/chordEstimation";
import { aggregateBassDistribution } from "../src/dsp/bass";
import { NO_CHORD } from "../src/lib/notes";
import type { ChordSegment } from "../src/types";
import { parseTruthChord } from "./measureReal";

export type NcCause = "routing" | "low-energy" | "short" | "score-gate";

export interface ChromaEvidenceSource {
  frames: Float32Array[];
  energies: Float32Array;
  frameDuration: number;
}

export interface NcSecondaryEvidence {
  /** 混合音クロマ（ステム経路での副次証拠） */
  mix: ChromaEvidenceSource;
  /** bass ステムの低域分布フレーム */
  bassFrames: Float32Array[];
}

export interface NcTruthSpan {
  startSec: number;
  endSec: number;
  chord: string;
}

/** estimateChordFrames と同一式の無音ゲートしきい値 */
export function silenceThresholdOf(energies: Float32Array): number {
  const sorted = [...energies].sort((a, b) => a - b);
  const medianEnergy = sorted[Math.floor(sorted.length / 2)] ?? 0;
  return Math.max(medianEnergy * 0.15, 1e-4);
}

export interface FrameEvidence {
  frameCount: number;
  /** 無音ゲートにかかったフレームの割合 */
  gatedShare: number;
  /** 非ゲートフレームのベストスコア平均（非ゲートが無ければ null） */
  meanBestScore: number | null;
  /** 非ゲートフレームの最頻ベストコード（無ければ null） */
  modalChord: string | null;
  /** 最頻コードが非ゲートフレームに占める割合 */
  modalShare: number;
  /** セグメント集計（エネルギー加重平均）クロマでの照合 */
  aggChord: string | null;
  aggScore: number | null;
  aggMargin: number | null;
}

/** 1 区間ぶんのフレーム証拠を計算する（判定経路・副次経路で共通） */
export function frameEvidence(
  source: ChromaEvidenceSource,
  startSec: number,
  endSec: number,
): FrameEvidence {
  const fd = source.frameDuration;
  const startIdx = Math.max(0, Math.floor(startSec / fd));
  const endIdx = Math.min(
    source.frames.length,
    Math.max(startIdx + 1, Math.ceil(endSec / fd)),
  );
  const threshold = silenceThresholdOf(source.energies);
  let gated = 0;
  let nonGated = 0;
  let scoreSum = 0;
  const chordCounts = new Map<string, number>();
  const avg = new Float32Array(12);
  let wSum = 0;
  for (let i = startIdx; i < endIdx; i++) {
    const energy = source.energies[i] ?? 0;
    const chroma = source.frames[i];
    const w = Math.max(energy, 1e-9);
    for (let p = 0; p < 12; p++) avg[p] += chroma[p] * w;
    wSum += w;
    if (energy < threshold) {
      gated++;
      continue;
    }
    nonGated++;
    const m = matchChord(chroma);
    scoreSum += m.score;
    chordCounts.set(m.chord, (chordCounts.get(m.chord) ?? 0) + 1);
  }
  let modalChord: string | null = null;
  let modalCount = 0;
  for (const [chord, count] of chordCounts) {
    if (count > modalCount) {
      modalCount = count;
      modalChord = chord;
    }
  }
  let aggChord: string | null = null;
  let aggScore: number | null = null;
  let aggMargin: number | null = null;
  if (wSum > 0) {
    for (let p = 0; p < 12; p++) avg[p] /= wSum;
    const m = matchChord(avg);
    aggChord = m.chord === NO_CHORD ? null : m.chord;
    aggScore = m.score;
    aggMargin = m.margin;
  }
  const frameCount = endIdx - startIdx;
  return {
    frameCount,
    gatedShare: frameCount > 0 ? gated / frameCount : 0,
    meanBestScore: nonGated > 0 ? scoreSum / nonGated : null,
    modalChord,
    modalShare: nonGated > 0 ? modalCount / nonGated : 0,
    aggChord,
    aggScore,
    aggMargin,
  };
}

export interface NcSegmentRecord {
  start: number;
  end: number;
  duration: number;
  cause: NcCause;
  /** パイプラインがこの N.C. セグメントに付けた信頼度（フレーム平均） */
  segmentConfidence: number;
  judge: FrameEvidence;
  /** 副次証拠（ステム経路のみ） */
  mixAggChord: string | null;
  mixAggScore: number | null;
  mixModalChord: string | null;
  mixModalShare: number | null;
  mixGatedShare: number | null;
  bassTopPc: number | null;
  bassTopShare: number | null;
  /** 前後のセグメント（N.C. でない直近ではなく、隣接そのもの） */
  prevChord: string | null;
  nextChord: string | null;
  /** 両隣が同じ非 N.C. コードならそのコード名 */
  flankedSameChord: string | null;
  /** 正解との重なり（正解がある曲のみ） */
  truthCoverShare: number | null;
  truthDominantChord: string | null;
  truthDominantShare: number | null;
  /** 正解コード（解釈可能）が区間の 50% 以上を占める */
  recoverable: boolean | null;
}

const SHORT_SEGMENT_SEC = 0.7;
const LOW_ENERGY_GATED_SHARE = 0.7;
const ROUTING_MIN_MODAL_SHARE = 0.5;

/**
 * 結果の N.C. セグメント全てを分類する。
 * judge はその経路でフレーム判定に使われたクロマ（混合音 split なら
 * 全帯域 frames、ステムなら other の全帯域 frames）を渡すこと。
 */
export function classifyNcSegments(
  segments: ChordSegment[],
  judge: ChromaEvidenceSource,
  secondary?: NcSecondaryEvidence,
  truth?: NcTruthSpan[],
): NcSegmentRecord[] {
  const records: NcSegmentRecord[] = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.chord !== NO_CHORD) continue;
    const duration = seg.end - seg.start;
    const judgeEv = frameEvidence(judge, seg.start, seg.end);

    let mixEv: FrameEvidence | null = null;
    let bassTopPc: number | null = null;
    let bassTopShare: number | null = null;
    if (secondary) {
      mixEv = frameEvidence(secondary.mix, seg.start, seg.end);
      const fd = secondary.mix.frameDuration;
      const agg = aggregateBassDistribution(
        secondary.bassFrames,
        Math.max(0, Math.floor(seg.start / fd)),
        Math.min(
          secondary.bassFrames.length,
          Math.max(1, Math.ceil(seg.end / fd)),
        ),
      );
      if (agg.total > 0) {
        bassTopPc = agg.topPc;
        bassTopShare = agg.topShare;
      }
    }

    let cause: NcCause;
    if (
      secondary &&
      mixEv &&
      mixEv.aggScore !== null &&
      mixEv.aggScore >= CONFIDENCE_THRESHOLD &&
      mixEv.modalShare >= ROUTING_MIN_MODAL_SHARE &&
      mixEv.aggChord !== null
    ) {
      cause = "routing";
    } else if (judgeEv.gatedShare >= LOW_ENERGY_GATED_SHARE) {
      cause = "low-energy";
    } else if (duration < SHORT_SEGMENT_SEC) {
      cause = "short";
    } else {
      cause = "score-gate";
    }

    const prev = i > 0 ? segments[i - 1] : null;
    const next = i < segments.length - 1 ? segments[i + 1] : null;
    const flankedSameChord =
      prev && next && prev.chord !== NO_CHORD && prev.chord === next.chord
        ? prev.chord
        : null;

    let truthCoverShare: number | null = null;
    let truthDominantChord: string | null = null;
    let truthDominantShare: number | null = null;
    let recoverable: boolean | null = null;
    if (truth) {
      let cover = 0;
      const perChord = new Map<string, number>();
      for (const t of truth) {
        const overlap = Math.min(seg.end, t.endSec) - Math.max(seg.start, t.startSec);
        if (overlap <= 0) continue;
        cover += overlap;
        if (parseTruthChord(t.chord)) {
          perChord.set(t.chord, (perChord.get(t.chord) ?? 0) + overlap);
        }
      }
      truthCoverShare = duration > 0 ? cover / duration : 0;
      let best = 0;
      for (const [chord, sec] of perChord) {
        if (sec > best) {
          best = sec;
          truthDominantChord = chord;
        }
      }
      truthDominantShare = duration > 0 ? best / duration : 0;
      recoverable = truthDominantShare >= 0.5;
    }

    records.push({
      start: Number(seg.start.toFixed(3)),
      end: Number(seg.end.toFixed(3)),
      duration: Number(duration.toFixed(3)),
      cause,
      segmentConfidence: Number(seg.confidence.toFixed(3)),
      judge: {
        ...judgeEv,
        gatedShare: Number(judgeEv.gatedShare.toFixed(3)),
        modalShare: Number(judgeEv.modalShare.toFixed(3)),
        meanBestScore:
          judgeEv.meanBestScore !== null
            ? Number(judgeEv.meanBestScore.toFixed(3))
            : null,
        aggScore:
          judgeEv.aggScore !== null ? Number(judgeEv.aggScore.toFixed(3)) : null,
        aggMargin:
          judgeEv.aggMargin !== null
            ? Number(judgeEv.aggMargin.toFixed(3))
            : null,
      },
      mixAggChord: mixEv?.aggChord ?? null,
      mixAggScore:
        mixEv?.aggScore !== null && mixEv?.aggScore !== undefined
          ? Number(mixEv.aggScore.toFixed(3))
          : null,
      mixModalChord: mixEv?.modalChord ?? null,
      mixModalShare: mixEv ? Number(mixEv.modalShare.toFixed(3)) : null,
      mixGatedShare: mixEv ? Number(mixEv.gatedShare.toFixed(3)) : null,
      bassTopPc,
      bassTopShare:
        bassTopShare !== null ? Number(bassTopShare.toFixed(3)) : null,
      prevChord: prev?.chord ?? null,
      nextChord: next?.chord ?? null,
      flankedSameChord,
      truthCoverShare:
        truthCoverShare !== null ? Number(truthCoverShare.toFixed(3)) : null,
      truthDominantChord,
      truthDominantShare:
        truthDominantShare !== null
          ? Number(truthDominantShare.toFixed(3))
          : null,
      recoverable,
    });
  }
  return records;
}

/** 原因別・回収可能性別の秒数集計 */
export interface NcCauseTotals {
  totalSec: number;
  segmentCount: number;
  byCause: Record<NcCause, { sec: number; segments: number }>;
  /** 正解がある場合のみ: 回収可能な N.C. 秒数（原因別） */
  recoverableSecByCause: Record<NcCause, number> | null;
  recoverableSec: number | null;
}

export function summarizeNcRecords(records: NcSegmentRecord[]): NcCauseTotals {
  const byCause: NcCauseTotals["byCause"] = {
    routing: { sec: 0, segments: 0 },
    "low-energy": { sec: 0, segments: 0 },
    short: { sec: 0, segments: 0 },
    "score-gate": { sec: 0, segments: 0 },
  };
  const hasTruth = records.some((r) => r.recoverable !== null);
  const recoverableByCause: Record<NcCause, number> = {
    routing: 0,
    "low-energy": 0,
    short: 0,
    "score-gate": 0,
  };
  let totalSec = 0;
  let recoverableSec = 0;
  for (const r of records) {
    totalSec += r.duration;
    byCause[r.cause].sec += r.duration;
    byCause[r.cause].segments += 1;
    if (r.recoverable) {
      recoverableSec += r.duration;
      recoverableByCause[r.cause] += r.duration;
    }
  }
  const round = (x: number) => Number(x.toFixed(2));
  for (const c of Object.keys(byCause) as NcCause[]) {
    byCause[c].sec = round(byCause[c].sec);
    recoverableByCause[c] = round(recoverableByCause[c]);
  }
  return {
    totalSec: round(totalSec),
    segmentCount: records.length,
    byCause,
    recoverableSecByCause: hasTruth ? recoverableByCause : null,
    recoverableSec: hasTruth ? round(recoverableSec) : null,
  };
}

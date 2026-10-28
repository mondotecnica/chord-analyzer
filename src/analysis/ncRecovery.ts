import { aggregateBassDistribution } from "../dsp/bass";
import { chordName, NO_CHORD } from "../lib/notes";
import type { ChordSegment } from "../types";
import { parseChordName } from "./bassCorrection";
import {
  CONFIDENCE_THRESHOLD,
  matchChord,
  silenceGateThreshold,
} from "./chordEstimation";
import { modeForRootFromBand } from "./splitBand";

/**
 * N.C.（無判定）区間の回復 — 診断に基づく3つの介入（全て明示オプトイン、
 * 既定は無効。採用判定は measurements/nc/NC_ANALYSIS.md）。
 *
 * 診断（同文書 §3）で分かったこと:
 * - Suno 05 stems の N.C. 46.7 秒の主因は「証拠が無い」ことではなく、
 *   判定材料 other ステムのフレームが、そのステム自身の中央値比で測る
 *   無音ゲート（< 15%）に大量に落ちること。落ちた区間でもセグメント
 *   集計クロマの照合スコアは 0.61–0.82 と明瞭なことが多い。
 * - 一方、実曲 stems（特に曲1）では集計照合が単独では系統的に外れる
 *   区間があり、「集計が明瞭」だけを条件に充填すると誤充填が勝つ。
 *   ただし別の視点（混合音クロマ）の集計とルートが一致する区間に
 *   限ると、充填候補は正解側に寄った。
 * - フレーム単位の信頼ゲート（0.55）を全体に下げる案は採らない。
 *   既にラベルが付いている区間の判定まで書き換えてしまうため、
 *   「落ちた区間だけを集計証拠で再判定する」方が局所的で安全。
 *
 * 介入（適用順は rematch → fallback → gap-fill。直接証拠に近い順）:
 * 1. segment-rematch: N.C. 区間の集計クロマを再照合する。条件は
 *    「判定経路の集計スコア >= 0.55」「第2の視点（混合音経路では
 *    上帯域クロマ、ステム経路では混合音クロマ）の集計とルート一致」
 *    「両経路とも 95% 以上ゲートにかかる全域無音ではない」
 *    「ゲートを生き残ったフレームが1つ以上ある」。ステム経路では
 *    強いベース証拠（トップシェア >= 0.5）が候補の構成音と矛盾する
 *    場合は棄却する。モードが2視点で割れた場合は、上帯域で
 *    決め直す（分業の原則どおり）。
 * 2. stems-fallback（ステム経路のみ）: rematch で埋まらなかった
 *    区間のうち、判定経路のゲート率が高く（>= 50%）証拠が薄いのに、
 *    混合音の集計が明瞭でフレーム最頻も過半一致し、強いベース証拠と
 *    矛盾しない場合に、混合音側の読みで充填する。
 * 3. gap-fill: 両隣が同一コードの短い（<= 1.0 秒）欠落だけを、その
 *    コードで充填する。区間自身の集計証拠が別のルートを強く示す
 *    場合は充填しない（本物のコード変化を平滑化で消さないため）。
 *
 * 充填したセグメントには出所（ncFill）を必ず付け、信頼度は
 * 通常の低信頼しきい値（0.55）未満に抑える。境界は一切変えない。
 */

export const NC_RECOVERY_CONFIG = {
  rematch: {
    /** これ未満の短い区間は集計が不安定なので対象外 */
    minDurationSec: 0.5,
    /** 集計照合スコアの下限（フレーム判定の信頼ゲートと同値） */
    minAggScore: CONFIDENCE_THRESHOLD,
    /** 両視点ともこの割合以上ゲートにかかれば「全域無音」として除外 */
    globalSilenceGatedShare: 0.95,
    /** ベース棄却が働くトップシェアの下限 */
    bassVetoShare: 0.5,
    confidenceScale: 0.75,
    confidenceCap: 0.5,
  },
  fallback: {
    /** 判定経路のゲート率がこれ未満なら「証拠はあるが意見が違う」ので上書きしない */
    minJudgeGatedShare: 0.5,
    minAggScore: CONFIDENCE_THRESHOLD,
    /** 混合音フレームの最頻コード（= 集計の読み）の割合の下限 */
    minModalShare: 0.5,
    /** ベース整合チェックが働くトップシェアの下限 */
    bassStrongShare: 0.5,
    confidenceScale: 0.65,
    confidenceCap: 0.45,
  },
  gapFill: {
    maxDurationSec: 1.0,
    /** 区間自身の集計がこれ以上で別ルートを示したら充填しない */
    contradictAggScore: CONFIDENCE_THRESHOLD,
    confidenceScale: 0.6,
    confidenceCap: 0.45,
  },
} as const;

// ---------------------------------------------------------------------------
// 共通ヘルパ
// ---------------------------------------------------------------------------

interface AggregateMatch {
  chord: string;
  root: number;
  mode: "major" | "minor";
  score: number;
  margin: number;
}

/** セグメント範囲のエネルギー加重平均クロマでのテンプレート照合 */
function aggregateMatch(
  frames: Float32Array[],
  energies: Float32Array,
  startIdx: number,
  endIdx: number,
): AggregateMatch | null {
  const avg = new Float32Array(12);
  let wSum = 0;
  const from = Math.max(0, startIdx);
  const to = Math.min(frames.length, endIdx);
  for (let i = from; i < to; i++) {
    const w = Math.max(energies[i] ?? 0, 1e-9);
    const frame = frames[i];
    for (let p = 0; p < 12; p++) avg[p] += frame[p] * w;
    wSum += w;
  }
  if (wSum <= 0) return null;
  for (let p = 0; p < 12; p++) avg[p] /= wSum;
  const m = matchChord(avg);
  const parsed = parseChordName(m.chord);
  if (!parsed) return null;
  return { chord: m.chord, root: parsed.root, mode: parsed.mode, score: m.score, margin: m.margin };
}

/** 範囲内のフレームが無音ゲートにかかる割合と、生き残ったフレーム数 */
function gateStats(
  energies: Float32Array,
  startIdx: number,
  endIdx: number,
): { gatedShare: number; nonGated: number } {
  const threshold = silenceGateThreshold(energies);
  const from = Math.max(0, startIdx);
  const to = Math.min(energies.length, endIdx);
  let gated = 0;
  for (let i = from; i < to; i++) {
    if ((energies[i] ?? 0) < threshold) gated++;
  }
  const n = Math.max(0, to - from);
  return { gatedShare: n > 0 ? gated / n : 1, nonGated: n - gated };
}

function frameRange(
  seg: ChordSegment,
  frameDuration: number,
): { startIdx: number; endIdx: number } {
  const startIdx = Math.floor(seg.start / frameDuration);
  const endIdx = Math.max(startIdx + 1, Math.ceil(seg.end / frameDuration));
  return { startIdx, endIdx };
}

/** 充填用の信頼度（フレーム判定と同じ式を縮小し、上限で抑える） */
function fillConfidence(
  score: number,
  margin: number,
  scale: number,
  cap: number,
): number {
  const raw = Math.min(1, score * 0.85 + margin * 0.75);
  return Math.min(cap, raw * scale);
}

function chordTones(root: number, mode: "major" | "minor"): ReadonlySet<number> {
  return new Set([root, (root + (mode === "major" ? 4 : 3)) % 12, (root + 7) % 12]);
}

// ---------------------------------------------------------------------------
// 1. セグメント再照合（rematch）
// ---------------------------------------------------------------------------

export interface NcRematchEvidence {
  /** 判定経路のクロマ（フレーム判定に使われたもの） */
  judgeFrames: Float32Array[];
  judgeEnergies: Float32Array;
  /**
   * 第2の視点のクロマ。混合音経路では上帯域クロマ（エネルギーは
   * 判定経路と共通）、ステム経路では混合音クロマ。
   */
  secondFrames: Float32Array[];
  secondEnergies: Float32Array;
  frameDuration: number;
  /**
   * モード決め直し用の上帯域クロマ（判定経路の上帯域）。
   * 2視点のモードが割れた場合にだけ使う。不要／不可能なら null。
   */
  modeFrames: Float32Array[] | null;
  /** ステム経路のみ: ベース低域分布（強い矛盾の棄却に使う） */
  bassFrames: Float32Array[] | null;
}

export function applyNcSegmentRematch(
  segments: ChordSegment[],
  ev: NcRematchEvidence,
): ChordSegment[] {
  const cfg = NC_RECOVERY_CONFIG.rematch;
  return segments.map((seg) => {
    if (seg.chord !== NO_CHORD) return seg;
    if (seg.end - seg.start < cfg.minDurationSec) return seg;
    const { startIdx, endIdx } = frameRange(seg, ev.frameDuration);

    const judgeGate = gateStats(ev.judgeEnergies, startIdx, endIdx);
    if (judgeGate.nonGated < 1) return seg;
    const judgeAgg = aggregateMatch(ev.judgeFrames, ev.judgeEnergies, startIdx, endIdx);
    if (!judgeAgg || judgeAgg.score < cfg.minAggScore) return seg;

    // 全域無音（フェードアウト末尾など）はどちらの視点でも証拠が無い
    const secondGate = gateStats(ev.secondEnergies, startIdx, endIdx);
    if (
      judgeGate.gatedShare >= cfg.globalSilenceGatedShare &&
      secondGate.gatedShare >= cfg.globalSilenceGatedShare
    ) {
      return seg;
    }

    // 第2の視点とルートが一致しない集計は信用しない
    const secondAgg = aggregateMatch(ev.secondFrames, ev.secondEnergies, startIdx, endIdx);
    if (!secondAgg || secondAgg.root !== judgeAgg.root) return seg;

    // 強いベース証拠が候補の構成音と矛盾する場合は棄却
    if (ev.bassFrames) {
      const bass = aggregateBassDistribution(ev.bassFrames, startIdx, endIdx);
      if (
        bass.total > 0 &&
        bass.topShare >= cfg.bassVetoShare &&
        !chordTones(judgeAgg.root, judgeAgg.mode).has(bass.topPc)
      ) {
        return seg;
      }
    }

    let mode = judgeAgg.mode;
    if (secondAgg.mode !== judgeAgg.mode && ev.modeFrames) {
      mode =
        modeForRootFromBand(
          ev.modeFrames,
          ev.judgeEnergies,
          startIdx,
          endIdx,
          judgeAgg.root,
        ) ?? judgeAgg.mode;
    }

    return {
      ...seg,
      chord: chordName(judgeAgg.root, mode),
      confidence: fillConfidence(
        judgeAgg.score,
        judgeAgg.margin,
        cfg.confidenceScale,
        cfg.confidenceCap,
      ),
      ncFill: "segment-rematch" as const,
    };
  });
}

// ---------------------------------------------------------------------------
// 2. ステム副次証拠フォールバック（fallback、ステム経路のみ）
// ---------------------------------------------------------------------------

export interface NcFallbackEvidence {
  /** 判定経路（other ステム）のエネルギー。ゲート率の判定に使う */
  judgeEnergies: Float32Array;
  /** 混合音クロマ（副次証拠の本体） */
  mixFrames: Float32Array[];
  mixEnergies: Float32Array;
  /** bass ステムの低域分布（整合チェックと bassPc の記録に使う） */
  bassFrames: Float32Array[];
  frameDuration: number;
}

export function applyNcStemsFallback(
  segments: ChordSegment[],
  ev: NcFallbackEvidence,
): ChordSegment[] {
  const cfg = NC_RECOVERY_CONFIG.fallback;
  return segments.map((seg) => {
    if (seg.chord !== NO_CHORD) return seg;
    const { startIdx, endIdx } = frameRange(seg, ev.frameDuration);

    // 判定経路に十分なエネルギーがある区間は「証拠の不在」ではなく
    // 「意見の相違」なので、副次証拠で上書きしない
    const judgeGate = gateStats(ev.judgeEnergies, startIdx, endIdx);
    if (judgeGate.gatedShare < cfg.minJudgeGatedShare) return seg;

    const mixGate = gateStats(ev.mixEnergies, startIdx, endIdx);
    if (mixGate.nonGated < 1) return seg;
    const mixAgg = aggregateMatch(ev.mixFrames, ev.mixEnergies, startIdx, endIdx);
    if (!mixAgg || mixAgg.score < cfg.minAggScore) return seg;

    // 混合音フレームの最頻コードが集計の読みと過半で一致すること
    const threshold = silenceGateThreshold(ev.mixEnergies);
    let modalCount = 0;
    let nonGated = 0;
    const from = Math.max(0, startIdx);
    const to = Math.min(ev.mixFrames.length, endIdx);
    for (let i = from; i < to; i++) {
      if ((ev.mixEnergies[i] ?? 0) < threshold) continue;
      nonGated++;
      if (matchChord(ev.mixFrames[i]).chord === mixAgg.chord) modalCount++;
    }
    if (nonGated === 0 || modalCount / nonGated < cfg.minModalShare) return seg;

    // 強いベース証拠とは矛盾しないこと（証拠として使えたら bassPc に残す）
    const bass = aggregateBassDistribution(ev.bassFrames, startIdx, endIdx);
    let bassPc: number | undefined;
    if (bass.total > 0 && bass.topShare >= cfg.bassStrongShare) {
      if (!chordTones(mixAgg.root, mixAgg.mode).has(bass.topPc)) return seg;
      bassPc = bass.topPc;
    }

    return {
      ...seg,
      chord: mixAgg.chord,
      confidence: fillConfidence(
        mixAgg.score,
        mixAgg.margin,
        cfg.confidenceScale,
        cfg.confidenceCap,
      ),
      ncFill: "stems-fallback" as const,
      ...(bassPc !== undefined && seg.bassPc === undefined ? { bassPc } : {}),
    };
  });
}

// ---------------------------------------------------------------------------
// 3. 短い欠落の充填（gap-fill）
// ---------------------------------------------------------------------------

/**
 * 両隣が同一コードの短い N.C. だけをそのコードで充填する。
 * 隣接ラベルは「この関数が受け取った時点」のもの（rematch /
 * fallback の充填結果を含む）で判定する。区間自身の集計証拠が
 * 別のルートを強く示す場合は、本物の変化の可能性があるため
 * 充填しない。
 */
export function applyNcGapFill(
  segments: ChordSegment[],
  judgeFrames: Float32Array[],
  judgeEnergies: Float32Array,
  frameDuration: number,
): ChordSegment[] {
  const cfg = NC_RECOVERY_CONFIG.gapFill;
  const out = segments.map((s) => ({ ...s }));
  for (let i = 0; i < out.length; i++) {
    const seg = out[i];
    if (seg.chord !== NO_CHORD) continue;
    if (seg.end - seg.start > cfg.maxDurationSec) continue;
    const prev = out[i - 1];
    const next = out[i + 1];
    if (!prev || !next) continue;
    if (prev.chord === NO_CHORD || prev.chord !== next.chord) continue;
    const flank = parseChordName(prev.chord);
    if (!flank) continue;

    const { startIdx, endIdx } = frameRange(seg, frameDuration);
    const agg = aggregateMatch(judgeFrames, judgeEnergies, startIdx, endIdx);
    if (agg && agg.score >= cfg.contradictAggScore && agg.root !== flank.root) {
      continue;
    }

    out[i] = {
      ...seg,
      chord: prev.chord,
      confidence: Math.min(
        cfg.confidenceCap,
        Math.min(prev.confidence, next.confidence) * cfg.confidenceScale,
      ),
      ncFill: "gap-fill" as const,
    };
  }
  return out;
}

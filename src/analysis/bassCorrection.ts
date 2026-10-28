import {
  aggregateBassDistribution,
  medianLowBandFrameTotal,
  type BassDistribution,
} from "../dsp/bass";
import { isChordToneBass } from "../lib/chordDisplay";
import { chordName, NOTE_NAMES, NO_CHORD } from "../lib/notes";
import type { ChordSegment } from "../types";
import { CHORD_TEMPLATES } from "./chordEstimation";

/**
 * Phase 1: ベース解析によるルート補正（PHASE1_PLAN.md セクション 4 の保守ルール）。
 *
 * - 補正はセグメント単位でのみ行う（フレーム単位の書き換えはしない）。
 * - 低域の証拠が強いセグメントだけを補正し、弱い／曖昧な証拠では
 *   Phase 0 の結果をそのまま残す（悪化防止が最優先）。
 * - ベース音は ChordSegment.bassPc に「ルートとは別フィールド」で記録する。
 *   ルートを黙って上書きすることはしない。補正した場合も bassPc は残る。
 *   あわせて Phase 3.2 では、補正で潰れる前の和声側の読みを
 *   ChordSegment.upperChord に残す（分数コードの層表示用。
 *   PHASE3_PLAN.md §3.2）。
 * - モード（major/minor）はベースからは決めない。補正後のルートに対して、
 *   セグメント平均の全帯域クロマとテンプレートの一致度で決める。
 * - 分数コード表示（C/E 等）自体は表示側（lib/chordDisplay.ts）の担当で、
 *   ここでは行わない。ただし Step 2 で、分数コードを補正で壊さないための
 *   ゲートを追加した: ベース音が検出コードの構成音（3rd / 5th）の場合は
 *   分数コードの可能性が高いため、候補コード（ルート=ベース音）のクロマ
 *   スコアが検出コードのスコアに迫る場合に限って補正する（下記
 *   chordToneScoreEpsilon 参照）。構成音でないベース音については
 *   従来通り証拠が強ければ補正する。
 */

/**
 * 補正しきい値（2026-10-27、合成 3 曲で調整した確定値。PHASE1_PLAN.md にも記録）。
 *
 * 調整時の観測: 正常なセグメントでは低域ピーク投票のトップシェアは 0.89 以上、
 * マージンは 0.77 以上、エネルギー比率は最小でも 0.40 だった。
 * 一方、ビン割り当て方式で誤読した区間（E のベースが F と読まれたケース）は
 * シェア 0.36／マージン 0.10 程度に留まった。
 * 下の値は実測の最低値から十分に余裕を取りつつ、誤読側の水準は確実に
 * 排除できる位置に置いた（実音源のノイズを考え、観測値ギリギリにはしない）。
 */
export const BASS_CORRECTION_CONFIG = {
  /** 補正に必要な、低域分布トップのシェア下限 */
  minTopShare: 0.5,
  /** 補正に必要な、トップ − 2位のマージン下限 */
  minMargin: 0.2,
  /**
   * 補正に必要な低域エネルギーの下限。
   * セグメント平均の低域フレーム総量 ÷ 曲全体の中央値、で表した比率。
   * （ベースがほぼ鳴っていない区間を証拠にしないため）
   */
  minEnergyRatio: 0.3,
  /** bassPc を記録するだけの場合のシェア下限（補正より緩い） */
  recordMinShare: 0.25,
  /** bassPc を記録するだけの場合のエネルギー比率下限 */
  recordMinEnergyRatio: 0.2,
  /**
   * Step 2: ベース音が検出コードの構成音の場合に補正を許可する
   * クロマスコア差の下限（候補スコア − 検出スコア >= −この値）。
   *
   * 合成 4 曲での実測（2026-10-27）:
   * - 補正が必要だった構成音ケース（Am → C の相対調取り違え ×5件）:
   *   スコア差は −0.041 〜 −0.034
   * - 補正してはいけない分数ケース（C/E で C → Em、F/A で F → Am 等）:
   *   スコア差は −0.144 以下
   * 両者のほぼ中間に 0.08 を置いた。
   */
  chordToneScoreEpsilon: 0.08,
} as const;

export interface BassEvidence extends BassDistribution {
  /** セグメント平均の低域総量 ÷ 曲全体の中央値 */
  energyRatio: number;
  /** 保守ルールの補正条件を満たすか */
  strong: boolean;
}

/** コード名 → ルート／モード（解析できない場合は null） */
export function parseChordName(
  chord: string,
): { root: number; mode: "major" | "minor" } | null {
  if (chord === NO_CHORD) return null;
  if (chord.endsWith("m")) {
    const root = NOTE_NAMES.indexOf(
      chord.slice(0, -1) as (typeof NOTE_NAMES)[number],
    );
    return root >= 0 ? { root, mode: "minor" } : null;
  }
  const root = NOTE_NAMES.indexOf(chord as (typeof NOTE_NAMES)[number]);
  return root >= 0 ? { root, mode: "major" } : null;
}

/** セグメント区間の低域証拠を集計する */
export function assessSegmentBass(
  bassFrames: Float32Array[],
  medianFrameTotal: number,
  startIdx: number,
  endIdx: number,
  frameCount: number,
): BassEvidence {
  const agg = aggregateBassDistribution(bassFrames, startIdx, endIdx);
  const framesInRange = Math.max(0, Math.min(endIdx, frameCount) - Math.max(0, startIdx));
  const meanTotal = framesInRange > 0 ? agg.total / framesInRange : 0;
  const energyRatio = medianFrameTotal > 0 ? meanTotal / medianFrameTotal : 0;
  const strong =
    agg.topShare >= BASS_CORRECTION_CONFIG.minTopShare &&
    agg.margin >= BASS_CORRECTION_CONFIG.minMargin &&
    energyRatio >= BASS_CORRECTION_CONFIG.minEnergyRatio;
  return { ...agg, energyRatio, strong };
}

/** セグメント平均の全帯域クロマ（フレームエネルギー加重、L2 正規化済み） */
function averageChroma(
  chromaFrames: Float32Array[],
  energies: Float32Array,
  startIdx: number,
  endIdx: number,
): Float32Array | null {
  const avg = new Float32Array(12);
  let wSum = 0;
  const from = Math.max(0, startIdx);
  const to = Math.min(chromaFrames.length, endIdx);
  for (let i = from; i < to; i++) {
    const w = Math.max(energies[i] ?? 0, 1e-9);
    for (let p = 0; p < 12; p++) avg[p] += chromaFrames[i][p] * w;
    wSum += w;
  }
  if (wSum > 0) for (let p = 0; p < 12; p++) avg[p] /= wSum;
  let norm = 0;
  for (let p = 0; p < 12; p++) norm += avg[p] * avg[p];
  norm = Math.sqrt(norm);
  if (norm === 0) return null;
  for (let p = 0; p < 12; p++) avg[p] /= norm;
  return avg;
}

function templateScore(
  avgNorm: Float32Array,
  root: number,
  mode: "major" | "minor",
): number {
  const t = CHORD_TEMPLATES.find((x) => x.root === root && x.mode === mode);
  if (!t) return 0;
  let dot = 0;
  for (let p = 0; p < 12; p++) dot += avgNorm[p] * t.vector[p];
  return dot;
}

/** セグメント平均クロマと、指定コードのテンプレートとの一致度（コサイン類似度） */
export function chordChromaScore(
  chromaFrames: Float32Array[],
  energies: Float32Array,
  startIdx: number,
  endIdx: number,
  root: number,
  mode: "major" | "minor",
): number {
  const avg = averageChroma(chromaFrames, energies, startIdx, endIdx);
  if (!avg) return 0;
  return templateScore(avg, root, mode);
}

/**
 * セグメント平均の全帯域クロマ（フレームエネルギー加重）に対して、
 * ルートを固定したときの major/minor のうち一致度の高い方を返す。
 * モード判定はベースではなく全帯域クロマから行うための関数。
 */
export function modeForRootFromChroma(
  chromaFrames: Float32Array[],
  energies: Float32Array,
  startIdx: number,
  endIdx: number,
  root: number,
): "major" | "minor" {
  const avg = averageChroma(chromaFrames, energies, startIdx, endIdx);
  if (!avg) return "major";

  let bestMode: "major" | "minor" = "major";
  let bestScore = -Infinity;
  for (const t of CHORD_TEMPLATES) {
    if (t.root !== root) continue;
    let dot = 0;
    for (let p = 0; p < 12; p++) dot += avg[p] * t.vector[p];
    if (dot > bestScore) {
      bestScore = dot;
      bestMode = t.mode;
    }
  }
  return bestMode;
}

/**
 * セグメント列にベース補正を適用した新しい配列を返す（入力は変更しない）。
 *
 * 各セグメントについて:
 * 1. 低域分布を集計し、証拠が一定以上あれば bassPc を別フィールドに記録する。
 * 2. 証拠が強く、かつトップのピッチクラスが現在のルートと異なる場合のみ、
 *    ルートを bassPc に補正する（モードは全帯域クロマから決め直す）。
 *    現在のルートと一致する場合と、証拠が弱い場合はコード名を変えない。
 */
export function applyBassCorrection(
  segments: ChordSegment[],
  chromaFrames: Float32Array[],
  bassFrames: Float32Array[],
  energies: Float32Array,
  frameDuration: number,
): ChordSegment[] {
  const medianTotal = medianLowBandFrameTotal(bassFrames);
  return segments.map((seg) => {
    const startIdx = Math.floor(seg.start / frameDuration);
    const endIdx = Math.max(startIdx + 1, Math.ceil(seg.end / frameDuration));
    const ev = assessSegmentBass(
      bassFrames,
      medianTotal,
      startIdx,
      endIdx,
      bassFrames.length,
    );

    const next: ChordSegment = { ...seg };
    if (
      ev.total > 0 &&
      ev.topShare >= BASS_CORRECTION_CONFIG.recordMinShare &&
      ev.energyRatio >= BASS_CORRECTION_CONFIG.recordMinEnergyRatio
    ) {
      next.bassPc = ev.topPc;
    }

    const parsed = parseChordName(seg.chord);
    if (!parsed || !ev.strong) return next;
    if (ev.topPc === parsed.root) return next;

    const mode = modeForRootFromChroma(
      chromaFrames,
      energies,
      startIdx,
      endIdx,
      ev.topPc,
    );

    // Step 2 ゲート: ベース音が検出コードの構成音（3rd / 5th）なら分数コード
    // （例: C/E）の可能性がある。その場合は、候補コード（ルート=ベース音）の
    // クロマスコアが検出コードに迫る場合に限って補正する。迫らない場合は
    // ルートを変えず、bassPc だけを残す（表示側で C/E の形になる）。
    // 構成音でないベース音は、従来通り証拠が強ければ補正する
    // （相対調の取り違え Am → C 等は構成音ケースだが、クロマが候補を
    // ほぼ同等に支持するため、このゲートを通過する）。
    if (isChordToneBass(parsed.root, parsed.mode, ev.topPc)) {
      const detectedScore = chordChromaScore(
        chromaFrames,
        energies,
        startIdx,
        endIdx,
        parsed.root,
        parsed.mode,
      );
      const candidateScore = chordChromaScore(
        chromaFrames,
        energies,
        startIdx,
        endIdx,
        ev.topPc,
        mode,
      );
      if (
        candidateScore <
        detectedScore - BASS_CORRECTION_CONFIG.chordToneScoreEpsilon
      ) {
        return next;
      }
    }

    // Phase 3.2: ルートを潰す前に、和声側の読み（補正前のコード）を
    // 上層として別フィールドに残す。表示側はこの層と bassPc を
    // 組み合わせて Am7/D のような分数表示を組み立てる
    // （PHASE3_PLAN.md §3.2）。補正しなかったセグメントには付けない。
    next.upperChord = seg.chord;
    next.chord = chordName(ev.topPc, mode);
    return next;
  });
}

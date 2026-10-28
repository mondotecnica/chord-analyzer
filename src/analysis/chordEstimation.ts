import { chordName, NO_CHORD } from "../lib/notes";
import type { ChordFrame } from "../types";

/**
 * コード推定: クロマベクトルとコードテンプレートのコサイン類似度による
 * テンプレートマッチング。
 *
 * Phase 0 の対象は major / minor トライアド（12ルート × 2 = 24 コード）と
 * 無音・低信頼時の N.C. のみ。7th / テンションは Phase 3 で
 * テンプレート集合を差し替えて拡張する想定。
 */

/** テンプレートにおける各構成音の重み（ルートを最も重視） */
const TEMPLATE_WEIGHTS = {
  root: 1.0,
  third: 0.9,
  fifth: 0.75,
} as const;

export interface ChordTemplate {
  chord: string;
  root: number;
  mode: "major" | "minor";
  /** 12 次元、L2 正規化済み */
  vector: Float32Array;
}

function buildTemplates(): ChordTemplate[] {
  const templates: ChordTemplate[] = [];
  for (let root = 0; root < 12; root++) {
    for (const mode of ["major", "minor"] as const) {
      const third = mode === "major" ? 4 : 3;
      const v = new Float32Array(12);
      v[root] = TEMPLATE_WEIGHTS.root;
      v[(root + third) % 12] = TEMPLATE_WEIGHTS.third;
      v[(root + 7) % 12] = TEMPLATE_WEIGHTS.fifth;
      let norm = 0;
      for (const x of v) norm += x * x;
      norm = Math.sqrt(norm);
      for (let i = 0; i < 12; i++) v[i] /= norm;
      templates.push({ chord: chordName(root, mode), root, mode, vector: v });
    }
  }
  return templates;
}

export const CHORD_TEMPLATES = buildTemplates();

export interface ChordMatch {
  chord: string;
  /** ベストテンプレートとのコサイン類似度 (0..1) */
  score: number;
  /** 2 位との差（大きいほど確からしい） */
  margin: number;
}

/** 1 つのクロマベクトルに対して最も合うコードを返す */
export function matchChord(chroma: ArrayLike<number>): ChordMatch {
  // クロマを L2 正規化
  let norm = 0;
  for (let i = 0; i < 12; i++) norm += chroma[i] * chroma[i];
  norm = Math.sqrt(norm);
  if (norm === 0) return { chord: NO_CHORD, score: 0, margin: 0 };

  let best = -Infinity;
  let second = -Infinity;
  let bestChord = NO_CHORD;
  for (const t of CHORD_TEMPLATES) {
    let dot = 0;
    for (let i = 0; i < 12; i++) dot += (chroma[i] / norm) * t.vector[i];
    if (dot > best) {
      second = best;
      best = dot;
      bestChord = t.chord;
    } else if (dot > second) {
      second = dot;
    }
  }
  return { chord: bestChord, score: best, margin: best - (second === -Infinity ? 0 : second) };
}

/** 低信頼とみなすコサイン類似度の下限 */
export const CONFIDENCE_THRESHOLD = 0.55;

/** 無音ゲートの相対係数（判定経路エネルギーの中央値に対する比率） */
const SILENCE_GATE_RATIO = 0.15;
/** 無音ゲートの絶対下限（デジタル無音の保護） */
const ABSOLUTE_ENERGY_FLOOR = 1e-4;

function medianEnergy(energies: Float32Array): number {
  const sorted = [...energies].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

/**
 * 無音ゲートのしきい値（フレームエネルギーの中央値 × 0.15、下限 1e-4）。
 * estimateChordFrames の内部式を切り出したもの。N.C. の解剖・回復
 * （ncRecovery.ts）が「どのフレームがゲートにかかったか」を同じ定義で
 * 再現するために共有する。
 */
export function silenceGateThreshold(energies: Float32Array): number {
  return Math.max(
    medianEnergy(energies) * SILENCE_GATE_RATIO,
    ABSOLUTE_ENERGY_FLOOR,
  );
}

/**
 * フレームゲートの方式。
 *
 * - "legacy"（現行）: 無音ゲートの参照は判定経路自身のエネルギー
 *   中央値だけ。ステム経路では other ステム自身の中央値比になるため、
 *   静かな和声区間のフレームが区間ごと落ちる（measurements/nc/
 *   NC_ANALYSIS.md §3 の診断）。
 * - "song-referenced"（再設計、measurements/nc/FRAME_GATE.md）:
 *   フレームが落ちるのは「判定経路が相対的に静か」かつ「曲全体
 *   （混合音）もその瞬間は静か」なときだけにする。無音ゲートが
 *   答える問いは「曲が鳴っているか」であって、ステムの相対的な
 *   強弱はダイナミクスであり無音ではない、という原則への移行。
 *   参照エネルギーが判定経路と同一（混合音経路）なら現行規則に
 *   厳密に帰着する。
 */
export type FrameGateMode = "legacy" | "song-referenced";

export interface FrameGateOptions {
  mode?: FrameGateMode;
  /**
   * 参照経路（混合音）のフレームエネルギー列。mode が
   * "song-referenced" で、これが渡された場合にだけ救済が働く。
   * 未指定なら mode によらず現行規則で動く（フォールバック）。
   */
  referenceEnergies?: Float32Array;
  /**
   * 救済フロアの比率: 救済されるフレームにも課す判定経路エネルギーの
   * 下限を「中央値 × この比率（下限 1e-4）」とする。既定 0 = 絶対下限
   * 1e-4 のみ（原則点）。正の値はブリード対策の床で、フロンティア
   * 測定（FRAME_GATE.md §2）でのみ使う。
   */
  rescueFloorRatio?: number;
}

/**
 * クロマフレーム列 → コードフレーム列。
 * 無音フレーム（エネルギーが全体中央値の一定割合以下）と
 * 低信頼フレームは N.C. とする。
 */
export function estimateChordFrames(
  chromaFrames: Float32Array[],
  energies: Float32Array,
  frameDuration: number,
  gate?: FrameGateOptions,
): ChordFrame[] {
  const silenceThreshold = silenceGateThreshold(energies);
  const referenceEnergies = gate?.referenceEnergies;
  const songReferenced =
    gate?.mode === "song-referenced" && referenceEnergies !== undefined;
  const referenceThreshold = songReferenced
    ? silenceGateThreshold(referenceEnergies)
    : 0;
  const rescueFloor = songReferenced
    ? Math.max(
        medianEnergy(energies) * (gate?.rescueFloorRatio ?? 0),
        ABSOLUTE_ENERGY_FLOOR,
      )
    : 0;

  return chromaFrames.map((chroma, i) => {
    const time = i * frameDuration;
    const energy = energies[i] ?? 0;
    if (energy < silenceThreshold) {
      // 曲参照ゲートの救済: 判定経路は相対的に静かでも、曲全体が
      // 鳴っている瞬間なら無音とはみなさない。救済されたフレームも
      // この後の信頼ゲート（スコア 0.55）を通常どおり通る。
      const rescued =
        songReferenced &&
        energy >= rescueFloor &&
        (referenceEnergies[i] ?? 0) >= referenceThreshold;
      if (!rescued) {
        return { time, chord: NO_CHORD, confidence: 0, energy };
      }
    }
    const m = matchChord(chroma);
    // 信頼度は類似度を主に、マージンを補助に使う
    const confidence = Math.min(1, m.score * 0.85 + m.margin * 0.75);
    if (m.score < CONFIDENCE_THRESHOLD) {
      return { time, chord: NO_CHORD, confidence, energy };
    }
    return { time, chord: m.chord, confidence, energy };
  });
}

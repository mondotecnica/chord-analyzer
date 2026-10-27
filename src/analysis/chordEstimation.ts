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

/**
 * クロマフレーム列 → コードフレーム列。
 * 無音フレーム（エネルギーが全体中央値の一定割合以下）と
 * 低信頼フレームは N.C. とする。
 */
export function estimateChordFrames(
  chromaFrames: Float32Array[],
  energies: Float32Array,
  frameDuration: number,
): ChordFrame[] {
  const sorted = [...energies].sort((a, b) => a - b);
  const medianEnergy = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const silenceThreshold = Math.max(medianEnergy * 0.15, 1e-4);

  return chromaFrames.map((chroma, i) => {
    const time = i * frameDuration;
    const energy = energies[i] ?? 0;
    if (energy < silenceThreshold) {
      return { time, chord: NO_CHORD, confidence: 0, energy };
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

import { noteName } from "../lib/notes";

/**
 * キー推定（Krumhansl–Schmuckler プロファイルとの Pearson 相関）と
 * テンポ推定（オンセット包絡の自己相関）。
 * どちらも「推定」であり、Phase 0 では土台として提供する。
 */

// Krumhansl–Kessler プロファイル
const MAJOR_PROFILE = [
  6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88,
];
const MINOR_PROFILE = [
  6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17,
];

function pearson(a: number[], b: number[]): number {
  const n = a.length;
  const ma = a.reduce((s, x) => s + x, 0) / n;
  const mb = b.reduce((s, x) => s + x, 0) / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  if (da === 0 || db === 0) return 0;
  return num / Math.sqrt(da * db);
}

export interface KeyEstimate {
  root: number;
  mode: "major" | "minor";
  keyName: string; // 例: "C major"
  correlation: number;
}

/** 集計クロマに対するキー候補1件のスコア（Phase 3.3 の局所キー用） */
export interface KeyScore {
  root: number;
  mode: "major" | "minor";
  correlation: number;
}

/**
 * 集計済みクロマ（12 ピッチクラスの合計）に対して全 24 キーの
 * Krumhansl プロファイル相関を計算し、降順に並べて返す。
 * estimateKey と Phase 3.3 の局所キー推定（localKey.ts）で共用する
 * （プロファイルと相関の定義はここが唯一の出所）。
 * 同点の場合は走査順（root 昇順、major → minor）を保つ（安定ソート）。
 */
export function rankKeys(aggChroma: ArrayLike<number>): KeyScore[] {
  const scores: KeyScore[] = [];
  for (let root = 0; root < 12; root++) {
    const rotated = Array.from({ length: 12 }, (_, i) => aggChroma[(root + i) % 12]);
    for (const [mode, profile] of [
      ["major", MAJOR_PROFILE],
      ["minor", MINOR_PROFILE],
    ] as const) {
      scores.push({ root, mode, correlation: pearson(rotated, profile) });
    }
  }
  return scores.sort((a, b) => b.correlation - a.correlation);
}

export function estimateKey(chromaFrames: Float32Array[]): KeyEstimate {
  const agg = new Array(12).fill(0);
  for (const f of chromaFrames) {
    for (let p = 0; p < 12; p++) agg[p] += f[p];
  }
  const best = rankKeys(agg)[0];
  return {
    root: best.root,
    mode: best.mode,
    keyName: `${noteName(best.root)} ${best.mode}`,
    correlation: best.correlation,
  };
}

/**
 * テンポ推定: オンセット包絡の自己相関のピークから BPM を求める。
 * 探索範囲は 40–200 BPM。オクターブ誤り対策として、
 * 倍テンポ候補より「60–180 BPM に収まる候補」を優先する素朴な補正を行う。
 * 精度は限定的なため UI では「推定 BPM」と明記する。
 */
export function estimateTempo(
  onsetEnvelope: Float32Array,
  frameDuration: number,
): number | null {
  const n = onsetEnvelope.length;
  if (n < 10 || frameDuration <= 0) return null;

  // 平均を引いて半波整流する（ベースライン同士の積が自己相関を
  // 支配してしまうのを防ぎ、オンセットのピークだけを残す）
  const mean = onsetEnvelope.reduce((s, x) => s + x, 0) / n;
  if (mean === 0) return null;
  const env = Float32Array.from(onsetEnvelope, (x) => Math.max(0, x - mean));

  const minBpm = 40;
  const maxBpm = 200;
  const minLag = Math.max(1, Math.floor(60 / maxBpm / frameDuration));
  const maxLag = Math.min(n - 1, Math.ceil(60 / minBpm / frameDuration));

  let bestLag = -1;
  let bestCorr = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let corr = 0;
    for (let i = 0; i + lag < n; i++) corr += env[i] * env[i + lag];
    corr /= n - lag;
    if (corr > bestCorr) {
      bestCorr = corr;
      bestLag = lag;
    }
  }
  if (bestLag < 0) return null;

  let bpm = 60 / (bestLag * frameDuration);
  // オクターブ補正: 一般的な楽曲レンジに寄せる
  while (bpm < 60) bpm *= 2;
  while (bpm > 180) bpm /= 2;
  return Math.round(bpm);
}

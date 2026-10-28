import { noteName } from "../lib/notes";
import type { LocalKeyWindow } from "../types";
import { rankKeys, type KeyEstimate } from "./keyTempo";

/**
 * Phase 3.3: 局所キー推定（PHASE3_PLAN.md §3.3、理論レイヤーの規則は §2）。
 *
 * 役割: 曲全体で1つだけのキー推定（keyTempo.estimateKey）に対し、
 * 時間で滑る窓ごとのキー候補を「文脈」として供給する小さな部品。
 * 使い道は「記録」と「消費」の2層に分かれる（2026-10-28 分割採用）:
 * - 記録（既定 ON）: 結果の localKeys への格納と表示・書き出し。
 *   ラベルには一切触れない
 * - 消費（既定 OFF、明示オプション localKey のときだけ）:
 *   第1段のモード決定への柔らかい prior（localKeyMode.ts）と、
 *   第2段のダイアトニック緩和のキー文脈（extensionDetection.ts）
 * どちらも prior は尤度を動かすだけで、候補の除外や判定の確定には
 * 使わない（§2 の確定規則）。転調か借用かの「解釈」も出さない:
 * 窓列には各窓の最有力キーと次点（相対調ペアであることが多い）を
 * 併記し、「スコア差が小さい」こと自体を記録として残す。
 *
 * 推定方法は全体キーと同じ Krumhansl–Schmuckler プロファイル相関
 * （keyTempo.rankKeys が唯一の定義）。窓の集計だけエネルギー加重に
 * する（無音・弱音フレームが窓を支配しないため）。全体キーは
 * estimateKey と同一の無加重集計で計算し、従来の全体キーと
 * 一致させる（margin だけ rankKeys から追加で得る）。
 */

export const LOCAL_KEY_CONFIG = {
  /** 窓の長さ（秒）。PHASE3_PLAN §3.3 の想定レンジ 8–16 秒の中間 */
  windowSec: 12,
  /** 窓の刻み（秒） */
  hopSec: 4,
} as const;

export interface LocalKeyContext {
  /** 曲全体のキー（estimateKey と同一結果）と、その次点との相関差 */
  global: KeyEstimate & { margin: number };
  windows: LocalKeyWindow[];
}

function aggregateWindow(
  chromaFrames: Float32Array[],
  energies: Float32Array,
  from: number,
  to: number,
  weighted: boolean,
): number[] {
  const agg = new Array(12).fill(0);
  const lo = Math.max(0, from);
  const hi = Math.min(chromaFrames.length, to);
  for (let i = lo; i < hi; i++) {
    const w = weighted ? Math.max(energies[i] ?? 0, 1e-9) : 1;
    for (let p = 0; p < 12; p++) agg[p] += chromaFrames[i][p] * w;
  }
  return agg;
}

/**
 * 局所キー文脈を推定する。chromaFrames はキー推定に使うクロマ
 * （両経路とも全体キーと同じ出所: 混合音経路は全帯域クロマ、
 * ステム経路は混合音クロマ）を渡す。
 */
export function estimateLocalKeys(
  chromaFrames: Float32Array[],
  energies: Float32Array,
  frameDuration: number,
  durationSec: number,
): LocalKeyContext {
  // 全体キー: estimateKey と同一の無加重集計（結果の一致を保証）
  const globalAgg = aggregateWindow(chromaFrames, energies, 0, chromaFrames.length, false);
  const globalRank = rankKeys(globalAgg);
  const g0 = globalRank[0];
  const g1 = globalRank[1];
  const global: LocalKeyContext["global"] = {
    root: g0.root,
    mode: g0.mode,
    keyName: `${noteName(g0.root)} ${g0.mode}`,
    correlation: g0.correlation,
    margin: g1 ? g0.correlation - g1.correlation : 0,
  };

  const windows: LocalKeyWindow[] = [];
  if (frameDuration > 0 && durationSec > 0 && chromaFrames.length > 0) {
    const { windowSec, hopSec } = LOCAL_KEY_CONFIG;
    const starts: number[] = [];
    if (durationSec <= windowSec) {
      starts.push(0);
    } else {
      for (let s = 0; s + windowSec <= durationSec; s += hopSec) starts.push(s);
      const lastStart = durationSec - windowSec;
      if (starts[starts.length - 1] < lastStart - 1e-9) starts.push(lastStart);
    }
    for (const start of starts) {
      const end = Math.min(durationSec, start + windowSec);
      const from = Math.floor(start / frameDuration);
      const to = Math.max(from + 1, Math.ceil(end / frameDuration));
      const agg = aggregateWindow(chromaFrames, energies, from, to, true);
      const rank = rankKeys(agg);
      const best = rank[0];
      const runnerUp = rank[1];
      windows.push({
        start,
        end,
        root: best.root,
        mode: best.mode,
        correlation: best.correlation,
        margin: runnerUp ? best.correlation - runnerUp.correlation : 0,
        runnerUpRoot: runnerUp ? runnerUp.root : best.root,
        runnerUpMode: runnerUp ? runnerUp.mode : best.mode,
      });
    }
  }
  return { global, windows };
}

/**
 * 時刻を含む窓を返す（無い場合は中心が最も近い窓）。
 * セグメントの文脈引きにはセグメント中点を渡す想定。
 */
export function localKeyWindowAt(
  ctx: LocalKeyContext,
  timeSec: number,
): LocalKeyWindow | null {
  if (ctx.windows.length === 0) return null;
  for (const w of ctx.windows) {
    if (timeSec >= w.start && timeSec < w.end) return w;
  }
  let best: LocalKeyWindow | null = null;
  let bestDist = Infinity;
  for (const w of ctx.windows) {
    const d = Math.abs((w.start + w.end) / 2 - timeSec);
    if (d < bestDist) {
      bestDist = d;
      best = w;
    }
  }
  return best;
}

/**
 * コードの構成音がキーの音階にどれだけ収まるか（0..1、重み付き割合）。
 * 局所キー文脈での「尤もらしさ」の定義（localKeyMode の prior 用）。
 *
 * 音階の取り方:
 * - major: 長音階 {0,2,4,5,7,9,11}。
 * - minor: 自然的短音階に旋律的短音階の上昇形（#6・#7）を加えた集合
 *   {0,2,3,5,7,8,9,10,11}。短調では V（長三和音）や IV（長三和音）が
 *   通常の語彙であり、それらを「調性外」として不利にしないため。
 *   それでも短調の ♭3 違い（例: Am 文脈での E♭）は集合に入らない。
 * 重みは root 1.0 / 3rd 1.0 / 5th 0.75（3rd がモードを決める音なので
 * root と同格に置く）。
 */
const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11];
const MINOR_SCALE = [0, 2, 3, 5, 7, 8, 9, 10, 11];

/** キーのスケール音ピッチクラスの集合（plausibility と二次ドミナント保護で共用） */
export function keyScalePcs(
  keyRoot: number,
  keyMode: "major" | "minor",
): Set<number> {
  return new Set(
    (keyMode === "major" ? MAJOR_SCALE : MINOR_SCALE).map(
      (iv) => (keyRoot + iv) % 12,
    ),
  );
}

export function chordKeyPlausibility(
  root: number,
  mode: "major" | "minor",
  keyRoot: number,
  keyMode: "major" | "minor",
): number {
  const scale = keyScalePcs(keyRoot, keyMode);
  const tones: [number, number][] = [
    [root, 1.0],
    [(root + (mode === "major" ? 4 : 3)) % 12, 1.0],
    [(root + 7) % 12, 0.75],
  ];
  let hit = 0;
  let total = 0;
  for (const [pc, w] of tones) {
    total += w;
    if (scale.has(pc)) hit += w;
  }
  return total > 0 ? hit / total : 0;
}

import type { LocalKeyWindow } from "../types";

/**
 * 局所キー窓列（AnalysisResult.localKeys）の表示用サマリ。
 *
 * 窓列そのものは「解釈の判定を出さない」記録（PHASE3_PLAN.md §2）だが、
 * 結果画面とテキスト書き出しでは人が読める形が要るため、ここでは
 * 表示専用に「中心キー」と「変化点」へ圧縮する。判定には使わない。
 *
 * - 中心キー: 窓の延べ時間（end − start の合計）が最大のキー。
 * - 変化点: 同一キーの連続（ラン）が切り替わる位置。1窓だけの
 *   フリップは前後が同じキーなら表示ノイズとして畳み、変化点として
 *   挙げるランは2窓以上のものに限る。
 */

export interface LocalKeyChangePoint {
  /** 変化が始まる窓の開始時刻（秒） */
  atSec: number;
  root: number; // 0=C .. 11=B
  mode: "major" | "minor";
}

export interface LocalKeySummary {
  dominantRoot: number;
  dominantMode: "major" | "minor";
  changes: LocalKeyChangePoint[];
}

const keyId = (root: number, mode: "major" | "minor") =>
  root * 2 + (mode === "major" ? 0 : 1);

interface Run {
  root: number;
  mode: "major" | "minor";
  start: number;
  windowCount: number;
}

export function summarizeLocalKeys(
  windows: LocalKeyWindow[] | undefined,
): LocalKeySummary | null {
  if (!windows || windows.length === 0) return null;

  // 中心キー（延べ窓時間の最大）
  const totals = new Map<number, number>();
  for (const w of windows) {
    const id = keyId(w.root, w.mode);
    totals.set(id, (totals.get(id) ?? 0) + Math.max(0, w.end - w.start));
  }
  let dominant: LocalKeyWindow = windows[0];
  let dominantTotal = -1;
  for (const w of windows) {
    const t = totals.get(keyId(w.root, w.mode)) ?? 0;
    if (t > dominantTotal) {
      dominantTotal = t;
      dominant = w;
    }
  }

  // ラン圧縮
  let runs: Run[] = [];
  for (const w of windows) {
    const last = runs[runs.length - 1];
    if (last && last.root === w.root && last.mode === w.mode) {
      last.windowCount += 1;
    } else {
      runs.push({ root: w.root, mode: w.mode, start: w.start, windowCount: 1 });
    }
  }
  // 1窓フリップ（前後が同じキー）を畳む
  for (let i = 1; i < runs.length - 1; i++) {
    const prev = runs[i - 1];
    const cur = runs[i];
    const next = runs[i + 1];
    if (
      cur.windowCount === 1 &&
      prev.root === next.root &&
      prev.mode === next.mode
    ) {
      prev.windowCount += cur.windowCount + next.windowCount;
      runs = [...runs.slice(0, i), ...runs.slice(i + 2)];
      i -= 1;
    }
  }

  const changes: LocalKeyChangePoint[] = [];
  for (let i = 1; i < runs.length; i++) {
    const run = runs[i];
    if (run.windowCount < 2) continue;
    changes.push({ atSec: run.start, root: run.root, mode: run.mode });
  }

  return {
    dominantRoot: dominant.root,
    dominantMode: dominant.mode,
    changes,
  };
}

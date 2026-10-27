import type { ChordFrame, ChordSegment } from "../types";

/**
 * フレーム列 → コードセグメント列への後処理。
 * 1. メディアンフィルタで単発の誤判定を除去
 * 2. 連続する同コードをマージ
 * 3. 短すぎるセグメントを隣接セグメントへ吸収
 */

export const SEGMENT_CONFIG = {
  medianWindow: 5, // フレーム数（奇数）
  minSegmentDuration: 0.35, // 秒。これ未満は吸収対象
} as const;

function medianFilter(frames: ChordFrame[], window: number): ChordFrame[] {
  if (window <= 1) return frames;
  const half = Math.floor(window / 2);
  return frames.map((f, i) => {
    const counts = new Map<string, number>();
    for (let k = -half; k <= half; k++) {
      const idx = Math.min(frames.length - 1, Math.max(0, i + k));
      const c = frames[idx].chord;
      counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    let winner = f.chord;
    let bestCount = -1;
    for (const [c, cnt] of counts) {
      if (cnt > bestCount) {
        bestCount = cnt;
        winner = c;
      }
    }
    return { ...f, chord: winner };
  });
}

export function framesToSegments(
  frames: ChordFrame[],
  frameDuration: number,
  totalDuration: number,
): ChordSegment[] {
  if (frames.length === 0) return [];
  const filtered = medianFilter(frames, SEGMENT_CONFIG.medianWindow);

  // 連続同コードをマージ
  interface Raw {
    start: number;
    end: number;
    chord: string;
    confidences: number[];
  }
  const raw: Raw[] = [];
  for (const f of filtered) {
    const last = raw[raw.length - 1];
    if (last && last.chord === f.chord) {
      last.end = f.time + frameDuration;
      last.confidences.push(f.confidence);
    } else {
      raw.push({
        start: f.time,
        end: f.time + frameDuration,
        chord: f.chord,
        confidences: [f.confidence],
      });
    }
  }
  if (raw.length > 0) raw[raw.length - 1].end = Math.max(raw[raw.length - 1].end, totalDuration);

  // 短いセグメントを、より長い隣接セグメントへ吸収（複数回繰り返す）
  let changed = true;
  while (changed && raw.length > 1) {
    changed = false;
    for (let i = 0; i < raw.length; i++) {
      const seg = raw[i];
      if (seg.end - seg.start >= SEGMENT_CONFIG.minSegmentDuration) continue;
      const prev = raw[i - 1];
      const next = raw[i + 1];
      const target =
        prev && next
          ? prev.end - prev.start >= next.end - next.start
            ? prev
            : next
          : (prev ?? next);
      if (!target) break;
      if (target === prev) {
        prev.end = seg.end;
        prev.confidences.push(...seg.confidences);
      } else {
        next.start = seg.start;
        next.confidences.push(...seg.confidences);
      }
      raw.splice(i, 1);
      changed = true;
      break;
    }
  }

  // 吸収後に同コード同士が隣接したら再マージ
  const merged: Raw[] = [];
  for (const seg of raw) {
    const last = merged[merged.length - 1];
    if (last && last.chord === seg.chord) {
      last.end = seg.end;
      last.confidences.push(...seg.confidences);
    } else {
      merged.push({ ...seg, confidences: [...seg.confidences] });
    }
  }

  return merged.map((seg, i) => ({
    id: i,
    start: seg.start,
    end: seg.end,
    chord: seg.chord,
    confidence:
      seg.confidences.length > 0
        ? seg.confidences.reduce((s, x) => s + x, 0) / seg.confidences.length
        : 0,
  }));
}

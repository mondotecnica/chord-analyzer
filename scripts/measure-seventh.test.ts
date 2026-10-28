/**
 * Phase 3.1 測定土台の実行ハーネス（vitest 経由）。
 * 通常の単体テストではなく「測定の実行」が目的。
 * 生成物: test-audio/song-e.wav と *.groundtruth.json、
 * measurements/PHASE3_SONG_E_BASELINE.md / song-e-results.json
 */
import { describe, expect, it } from "vitest";
import { runSeventhMeasurement } from "./measureSeventh";

describe("Phase 3.1 測定土台：Song E ベースライン測定", () => {
  it("Song E を生成・解析し、ベースラインレポートを書き出す", async () => {
    const measurements = await runSeventhMeasurement();
    expect(measurements).toHaveLength(1);
    const msr = measurements[0];
    expect(msr.durationSec).toBeGreaterThan(0);
    expect(msr.truth.segments).toHaveLength(8);
    // 全小節に 7th を含む完全正解が付いていること
    expect(msr.truth.segments.every((s) => s.fullChord !== undefined)).toBe(true);
    expect(msr.detectedSegments.length).toBeGreaterThan(0);
    // eslint-disable-next-line no-console
    console.log(
      `${msr.truth.title}: key ${msr.truth.key} → ${msr.detectedKey}, ` +
        `BPM ${msr.truth.bpm} → ${msr.detectedBpm}, ` +
        `core root ${(msr.rootAccuracy * 100).toFixed(1)}%, ` +
        `core triad ${(msr.triadAccuracy * 100).toFixed(1)}%, ` +
        `N.C. ${(msr.ncShare * 100).toFixed(1)}%`,
    );
  }, 180_000);
});

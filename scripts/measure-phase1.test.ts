/**
 * Phase 1 Step 1 測定の実行ハーネス（vitest 経由）。
 * `npm run measure:phase1` で単独実行するのが基本。
 *
 * 生成物:
 * - measurements/PHASE1_STEP1.md / measurements/phase1-step1-results.json
 */
import { describe, expect, it } from "vitest";
import { runPhase1Measurement } from "./measurePhase1";

describe("Phase 1 Step 1 測定（ベース補正の前後比較）", () => {
  it("合成3曲で前後を測定し、レポートを書き出す", async () => {
    const result = await runPhase1Measurement();
    expect(result.songs).toHaveLength(3);
    for (const s of result.songs) {
      // eslint-disable-next-line no-console
      console.log(
        `${s.before.truth.title}: root ${(s.before.rootAccuracy * 100).toFixed(1)}% → ${(s.after.rootAccuracy * 100).toFixed(1)}%, ` +
          `triad ${(s.before.triadAccuracy * 100).toFixed(1)}% → ${(s.after.triadAccuracy * 100).toFixed(1)}%, ` +
          `changed segments: ${s.changedSegments.map((c) => `${c.from}→${c.to}`).join(", ") || "none"}`,
      );
    }
    // eslint-disable-next-line no-console
    console.log(
      `overall: root ${(result.overall.before.rootAccuracy * 100).toFixed(1)}% → ${(result.overall.after.rootAccuracy * 100).toFixed(1)}%, ` +
        `triad ${(result.overall.before.triadAccuracy * 100).toFixed(1)}% → ${(result.overall.after.triadAccuracy * 100).toFixed(1)}%`,
    );
  }, 300_000);
});

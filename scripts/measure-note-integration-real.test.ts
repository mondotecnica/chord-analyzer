/**
 * 音符レベル統合の測定（実曲ステム s-conditional／混合音）。
 * 実行: npm run measure:note-integration
 * 結果は measurements/notepitch/notepitch-integration-real-{stems,mixture}.json。
 * 判定は NOTEPITCH_INTEGRATION.md の事前登録基準（実曲は検証専用、
 * しきい値調整には使わない）。
 */
import { describe, expect, it } from "vitest";
import {
  runIntegrationRealMixture,
  runIntegrationRealStems,
} from "./measureNoteIntegration";

const TOL = 0.005;

describe("音符統合: 実曲", () => {
  it(
    "ステム経路（s-conditional）で全アームを測定する",
    async () => {
      const entries = await runIntegrationRealStems();
      expect(entries.map((e) => e.slug)).toEqual([
        "put-your-records-on",
        "everything",
        "a-hard-days-night",
      ]);
      for (const entry of entries) {
        for (const arm of Object.values(entry.arms)) {
          expect(arm.core.rootAccuracy).toBeGreaterThanOrEqual(0);
          expect(arm.core.rootAccuracy).toBeLessThanOrEqual(1);
        }
      }
    },
    1_800_000,
  );

  it(
    "混合音経路で全アームを測定し、OFF が現行記録を再現する",
    async () => {
      const entries = await runIntegrationRealMixture();
      expect(entries).toHaveLength(3);
      // 混合音はゲート不変のため Phase 3.1 の混合音 OFF 記録
      // （root 0.541／triad 0.642／core 0.311、曲1）を再現するはず
      const song1 = entries.find((e) => e.slug === "put-your-records-on")!;
      expect(Math.abs(song1.arms.off.core.rootAccuracy - 0.541)).toBeLessThan(TOL);
      expect(Math.abs(song1.arms.off.core.triadAccuracy - 0.642)).toBeLessThan(TOL);
    },
    1_800_000,
  );
});

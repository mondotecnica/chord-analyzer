/**
 * 音符レベル統合の測定（Suno 05 フィクスチャ Q1〜Q4、両経路）。
 * 実行: npm run measure:note-integration
 * 結果は measurements/notepitch/notepitch-integration-suno.json。
 * Q1/Q4 のベース正否は noteBass の事前登録基準に直結する。
 */
import { describe, expect, it } from "vitest";
import { runIntegrationSuno } from "./measureNoteIntegration";

describe("音符統合: Suno フィクスチャ", () => {
  it(
    "全アームのフィクスチャを測定する",
    async () => {
      const entry = await runIntegrationSuno();
      const off = entry.arms.off;
      // OFF の健全性確認: Q2 の Cm 秒数は小さい（3.2 時点の記録では 0）
      expect(off.stems.q2CmSec).toBeLessThan(5);
      expect(off.stems.q3.some((s) => s.pass)).toBe(true); // 少なくとも C は一致
      // 全アームで Q1/Q4 のベース判定フィールドが埋まっていること
      for (const arm of Object.values(entry.arms)) {
        for (const path of [arm.stems, arm.mixture]) {
          expect(path.q1).toHaveLength(2);
          expect(typeof path.q4.bassCorrect).toBe("boolean");
        }
      }
    },
    1_800_000,
  );
});

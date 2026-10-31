/**
 * 「宵のひかり」Suno ステム直接入力の検証測定。
 * 実行: npm run measure:suno-yoi
 * 結果は measurements/suno-yoi-results.json。
 * 素材（stem-work/suno-yoi/）が無い環境ではスキップする
 * （measureStems と同じ流儀。npm test を壊さないため）。
 */
import { describe, expect, it } from "vitest";
import { runSunoYoi, sunoYoiReady } from "./measureSunoYoi";

const ready = sunoYoiReady();

describe("Suno ステム直接入力: 宵のひかり", () => {
  (ready ? it : it.skip)(
    "アーム A/B/C/D/C44 を測定し、Q1〜Q4 フィクスチャを判定する",
    async () => {
      const out = await runSunoYoi();
      for (const id of ["A", "B", "C", "D", "C44"]) {
        expect(out.arms[id].segmentCount).toBeGreaterThan(0);
        expect(out.arms[id].ncSharePct).toBeLessThan(100);
      }
      // フィクスチャの形の健全性（合否そのものは測定結果であって
      // テストの合格条件ではないため、構造だけ確認する）
      for (const arm of ["B", "C", "C44"] as const) {
        expect(out.fixtures[arm].q1).toHaveLength(2);
        expect(out.fixtures[arm].q3).toHaveLength(4);
        expect(typeof out.fixtures[arm].q2.cmSec).toBe("number");
      }
      expect(out.disagreementWindows.length).toBeGreaterThan(0);
    },
    1_800_000,
  );
});

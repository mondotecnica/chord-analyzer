/**
 * 合成テスト音源ベースライン測定の実行ハーネス（vitest 経由）。
 *
 * 通常の単体テストではなく「測定の実行」が目的なので、
 * `npm run measure:synthetic` で単独実行するのが基本。
 * （npm test でも一緒に走るが、その場合は生成物が再作成されるだけ。）
 *
 * 生成物:
 * - test-audio/song-{a,b,c}.wav と *.groundtruth.json
 * - measurements/SYNTHETIC_BASELINE.md / results.json
 */
import { describe, expect, it } from "vitest";
import { runSyntheticMeasurement } from "./measureSynthetic";

describe("合成テスト音源ベースライン測定", () => {
  it("3曲を生成・解析し、正解率レポートを書き出す", async () => {
    const measurements = await runSyntheticMeasurement();
    expect(measurements).toHaveLength(3);
    for (const msr of measurements) {
      // ハーネスが回ったことの最低限の健全性チェック（精度の合否判定ではない）
      expect(msr.durationSec).toBeGreaterThan(0);
      expect(msr.rootAccuracy).toBeGreaterThanOrEqual(0);
      expect(msr.rootAccuracy).toBeLessThanOrEqual(1);
      expect(msr.detectedSegments.length).toBeGreaterThan(0);
      // eslint-disable-next-line no-console
      console.log(
        `${msr.truth.title}: key ${msr.truth.key} → ${msr.detectedKey}, ` +
          `BPM ${msr.truth.bpm} → ${msr.detectedBpm}, ` +
          `root ${(msr.rootAccuracy * 100).toFixed(1)}%, ` +
          `triad ${(msr.triadAccuracy * 100).toFixed(1)}%, ` +
          `N.C. ${(msr.ncShare * 100).toFixed(1)}%`,
      );
    }
  }, 180_000);
});

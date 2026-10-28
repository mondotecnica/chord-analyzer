import { describe, expect, it } from "vitest";
import { runFrameGate } from "./measureGate";

/**
 * フレームゲート再設計（曲参照ゲート）の測定。ここで固定するのは
 * 「構造的な不変条件」だけ:
 * - legacy アームが既存記録（NC ラウンドのベースライン）と一致すること
 * - 混合音経路では song アームが legacy とビット一致すること（P5 帰着）
 * - 真の無音ウィンドウ（Suno アウトロ / AHDN 曲尾）に判定が
 *   入らないこと（P4）
 * - Suno フィクスチャが legacy と song で一致すること（P6）
 * - 変換会計が閉じること
 * 採用可否そのものは measurements/nc/FRAME_GATE.md の事前登録基準
 * （P1–P7）で判定し、ここでは assert しない（不採用でもテストは
 * 緑であるべき。measure-nc-recovery.test.ts と同じ規律）。
 *
 * 生成物: measurements/nc/frame-gate.json
 */
describe("フレームゲート再設計 A/B", () => {
  it("全スイートでゲート方式を測定し、不変条件を満たす", async () => {
    const run = await runFrameGate();
    const suites = run.suites;
    expect(suites.length).toBeGreaterThanOrEqual(10);

    // legacy アームが既存記録と一致する（アンカー）
    const sunoMixture = suites.find((s) => s.suite === "suno-mixture")!;
    const sunoStems = suites.find((s) => s.suite === "suno-stems")!;
    const song1Stems = suites.find(
      (s) => s.suite === "real-stems" && s.id === "put-your-records-on",
    )!;
    expect(sunoMixture.arms.legacy.ncShare).toBeCloseTo(0.052, 2);
    expect(sunoStems.arms.legacy.ncShare).toBeCloseTo(0.228, 2);
    expect(song1Stems.arms.legacy.ncShare).toBeCloseTo(0.069, 2);

    for (const suite of suites) {
      const legacy = suite.arms.legacy;
      // legacy アーム自身の churn はゼロ
      expect(legacy.churn.labelChangedSec, `${suite.id} legacy churn`).toBe(0);
      expect(legacy.churn.judgedToNcSec, `${suite.id} legacy churn`).toBe(0);

      for (const [name, arm] of Object.entries(suite.arms)) {
        const where = `${suite.suite}/${suite.id} arm ${name}`;
        // 真の無音ウィンドウに判定が入らない（ウィンドウ以降に始まる
        // セグメントは全て N.C.、かつ重なり秒数も legacy を超えない。
        // legacy 自身、境界をまたぐ最後の実コードの残響ぶんの重なりは
        // 持ちうるため、ゼロではなく「増やさないこと」を assert する）
        if (arm.silenceWindowStartsNc !== null) {
          expect(arm.silenceWindowStartsNc, where).toBe(true);
          expect(
            arm.judgedSecInSilenceWindow!,
            where,
          ).toBeLessThanOrEqual(legacy.judgedSecInSilenceWindow!);
        }
        // 変換会計が閉じる（ベースライン N.C. 秒と一致）
        if (arm.conversion) {
          const c = arm.conversion;
          const accounted =
            c.convertedCorrectSec +
            c.convertedWrongSec +
            c.filledUnverifiableSec +
            c.stillNcSec;
          expect(accounted, where).toBeCloseTo(c.baselineNcSec, 1);
        }
      }

      // P5: 混合音経路では song が legacy に帰着する（ビット一致）
      if (suite.suite !== "real-stems" && suite.suite !== "suno-stems") {
        expect(
          suite.arms.song.segmentsIdenticalToLegacy,
          `${suite.suite}/${suite.id} song degeneracy`,
        ).toBe(true);
        expect(suite.arms.song.ncShare).toBe(suite.arms.legacy.ncShare);
      }
    }

    // P6: Suno フィクスチャが legacy と song で一致する
    const fl = run.sunoFixturesLegacy;
    const fs = run.sunoFixturesSong;
    expect(fl, "フィクスチャ（legacy）が未計算").not.toBeNull();
    expect(fs, "フィクスチャ（song）が未計算").not.toBeNull();
    expect(fs!.q1.pass).toBe(fl!.q1.pass);
    expect(fs!.q2.stage2Pass).toBe(fl!.q2.stage2Pass);
    expect(fs!.q3.pass).toBe(fl!.q3.pass);
    // Cm 秒数は境界 1 フレーム分（0.05 秒）のずれまでを不変とみなす。
    // ゲートはフレーム判定そのものを変えるため、回復介入（非 N.C. に
    // 触れない）と同じ厳密一致は原理的に成り立たない。登録した
    // 「一致」副条項との差異は FRAME_GATE.md §4 に開示する。
    expect(Math.abs(fs!.q2.stemsCmSecOn - fl!.q2.stemsCmSecOn)).toBeLessThanOrEqual(0.06);
  }, 1_800_000);
});

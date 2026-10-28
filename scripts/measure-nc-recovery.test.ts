import { describe, expect, it } from "vitest";
import { runNcRecovery } from "./measureNc";

/**
 * N.C. 回復の A/B 測定。ここで固定するのは「構造的な不変条件」だけ:
 * - ベースライン（既定）が既存記録どおりであること
 * - 介入が非 N.C. セグメントを一切変えないこと（局所性）
 * - 全域無音への充填が 0 で、Suno アウトロが N.C. のままであること
 * - 変換の会計（正解＋誤り＋未検証＋残存）がベースライン N.C. と一致すること
 * 採用可否そのものは measurements/nc/NC_ANALYSIS.md の事前登録基準で
 * 判定し、ここでは assert しない（不採用でもテストは緑であるべき）。
 *
 * 生成物: measurements/nc/nc-recovery.json
 */
describe("N.C. 回復 A/B", () => {
  it("全スイートで介入を測定し、不変条件を満たす", async () => {
    const run = await runNcRecovery();
    const suites = run.suites;
    expect(suites.length).toBeGreaterThanOrEqual(10);

    // ベースラインの N.C. 割合が既存記録と一致する
    const sunoMixture = suites.find((s) => s.suite === "suno-mixture")!;
    const sunoStems = suites.find((s) => s.suite === "suno-stems")!;
    const song1Stems = suites.find(
      (s) => s.suite === "real-stems" && s.id === "put-your-records-on",
    )!;
    expect(sunoMixture.baseline.ncShare).toBeCloseTo(0.052, 2);
    expect(sunoStems.baseline.ncShare).toBeCloseTo(0.228, 2);
    expect(song1Stems.baseline.ncShare).toBeCloseTo(0.069, 2);

    for (const suite of suites) {
      for (const [name, arm] of Object.entries(suite.arms)) {
        const where = `${suite.suite}/${suite.id} arm ${name}`;
        // 局所性: 非 N.C. セグメントは不変
        expect(arm.nonNcIdentical, where).toBe(true);
        // 全域無音への充填は 0
        expect(arm.filledGlobalSilenceSec, where).toBe(0);
        // 充填には必ず出所が付き、会計が閉じる
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
    }

    // Suno フィクスチャの pass 判定と Q2 の Cm 秒数が all アームで不変
    const base = run.sunoFixturesBaseline;
    const rec = run.sunoFixturesRecovery;
    expect(base, "フィクスチャ（ベースライン）が未計算").not.toBeNull();
    expect(rec, "フィクスチャ（回復）が未計算").not.toBeNull();
    expect(rec!.q1.pass).toBe(base!.q1.pass);
    expect(rec!.q2.stage2Pass).toBe(base!.q2.stage2Pass);
    expect(rec!.q3.pass).toBe(base!.q3.pass);
    expect(rec!.q2.stemsCmSecOn).toBeCloseTo(base!.q2.stemsCmSecOn, 6);

    // Suno アウトロ（201 秒以降）は all アームでも全て N.C. のまま
    expect(run.sunoOutroStillNc).toBe(true);
  }, 900_000);
});

/**
 * Theory Engine 第1段の測定ラッパー（vitest 経由）。
 * 実行: npm run measure:theory-step1
 * 本体は scripts/measureTheoryStep1.ts。結果は
 * measurements/theory/theory-step1-results.json に書かれる。
 * 事前登録基準 1（OFF/ON 不変性）と基準 2（整合性）をここで assert する。
 */
import { describe, expect, it } from "vitest";
import {
  coverageShares,
  KS,
  runTheoryStep1Measurement,
} from "./measureTheoryStep1";

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

describe("Theory Engine 第1段（候補リストの露出）", () => {
  it("不変性・整合性を検査し、オラクル被覆率を測る", async () => {
    const results = await runTheoryStep1Measurement();

    for (const s of results.suites) {
      console.log(
        `${s.suite} [${s.path}]: invariant=${s.invariant} violations=${s.violations.length}`,
      );
      for (const v of s.violations.slice(0, 10)) console.log(`  NG: ${v}`);
    }
    for (const [name, agg] of Object.entries(results.aggregates)) {
      const sh = coverageShares(agg.labeled);
      console.log(
        `${name} (labeled): root ${KS.map((k, i) => `k${k}=${pct(sh.root[i])}`).join(" ")} / ` +
          `triad ${KS.map((k, i) => `k${k}=${pct(sh.triad[i])}`).join(" ")} / ` +
          `core ${KS.map((k, i) => `k${k}=${pct(sh.core[i])}`).join(" ")}`,
      );
    }
    for (const s of results.suites) {
      if (!s.fixtures) continue;
      for (const f of s.fixtures) {
        console.log(
          `${s.suite} fixture ${f.name}: inTopK ${KS.map((k, i) => `k${k}=${pct(f.inTopK[i])}`).join(" ")}` +
            (f.bassMatch !== undefined ? ` bassMatch=${pct(f.bassMatch)}` : "") +
            (f.negative ? " (negative)" : ""),
        );
      }
    }

    // 基準1: 全スイートで OFF/ON 完全一致
    expect(results.totals.invariantSuites).toBe(results.totals.totalSuites);
    // 基準2: 整合性違反ゼロ
    expect(results.totals.violationCount).toBe(0);
  }, 900_000);
});

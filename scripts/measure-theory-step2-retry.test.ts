/**
 * Theory Engine 第2段・再挑戦（v2）の測定ラッパー（vitest 経由）。
 * 実行: npm run measure:theory-step2-retry
 * 本体は scripts/measureTheoryStep2Retry.ts。結果は
 * measurements/theory/theory-step2-retry-results.json に書かれる。
 * ここでは事前登録基準のうち構造的なもの（基準5: OFF 不変性・
 * N.C. 不変・初回保存値との一致）を assert する。品質基準
 * （1〜4）とフィクスチャ関門（基準3）の判定は結果文書に記録し、
 * 関門の合否パターンは測定で確定したものを記録として固定する
 * （第2段の先例と同じ）。
 */
import { describe, expect, it } from "vitest";
import { coverageShares } from "./measureTheoryStep1";
import { runTheoryStep2RetryMeasurement } from "./measureTheoryStep2Retry";

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const pt = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}pt`;

describe("Theory Engine 第2段・再挑戦（v2 系列再評価器）", () => {
  it("事前登録基準を検査し、デルタと反転内訳を測る", async () => {
    const results = await runTheoryStep2RetryMeasurement();

    for (const s of results.suites) {
      console.log(
        `${s.suite} [${s.path}]: offInvariant=${s.offInvariant} ncDelta=${Math.abs(s.ncReevalSec - s.ncBaselineSec).toFixed(3)}s`,
      );
      if (s.baseline && s.reeval && s.flips) {
        const b = coverageShares(s.baseline);
        const r = coverageShares(s.reeval);
        const v1 = s.reevalV1 ? coverageShares(s.reevalV1) : null;
        console.log(
          `  root ${pct(b.root[0])}→${pct(r.root[0])} (${pt(r.root[0] - b.root[0])}) / ` +
            `triad ${pct(b.triad[0])}→${pct(r.triad[0])} (${pt(r.triad[0] - b.triad[0])}) / ` +
            `core ${pct(b.core[0])}→${pct(r.core[0])} (${pt(r.core[0] - b.core[0])})` +
            (v1 ? `  [v1参考 triad ${pct(v1.triad[0])}]` : ""),
        );
        console.log(
          `  flips: segs=${s.flips.flippedSegments} fixed=${s.flips.fixedSec.toFixed(1)}s broken=${s.flips.brokenSec.toFixed(1)}s changedWrong=${s.flips.changedWrongSec.toFixed(1)}s ` +
            `rootFixed=${s.flips.fixedRootSec.toFixed(1)}s rootBroken=${s.flips.brokenRootSec.toFixed(1)}s`,
        );
        if (s.flipsV1) {
          console.log(
            `  flips(v1参考): segs=${s.flipsV1.flippedSegments} fixed=${s.flipsV1.fixedSec.toFixed(1)}s broken=${s.flipsV1.brokenSec.toFixed(1)}s changedWrong=${s.flipsV1.changedWrongSec.toFixed(1)}s`,
          );
        }
      }
      for (const f of s.fixtures ?? []) {
        console.log(
          `  fixture ${f.name}: ${pct(f.baseline)}→${pct(f.reeval)}` +
            (f.bassBaseline !== undefined
              ? ` bass ${pct(f.bassBaseline)}→${pct(f.bassReeval ?? 0)}`
              : "") +
            (f.negative ? " (negative)" : ""),
        );
      }
      for (const f of s.fixturesV1 ?? []) {
        console.log(`  fixture(v1参考) ${f.name}: ${pct(f.baseline)}→${pct(f.reeval)}`);
      }
    }
    for (const [name, agg] of Object.entries(results.aggregates)) {
      const b = coverageShares(agg.baseline);
      const r = coverageShares(agg.reeval);
      const v1 = coverageShares(agg.reevalV1);
      console.log(
        `AGG ${name}: root ${pct(b.root[0])}→${pct(r.root[0])} (${pt(r.root[0] - b.root[0])}) / ` +
          `triad ${pct(b.triad[0])}→${pct(r.triad[0])} (${pt(r.triad[0] - b.triad[0])}) / ` +
          `core ${pct(b.core[0])}→${pct(r.core[0])} (${pt(r.core[0] - b.core[0])}) / ` +
          `[v1参考 root ${pt(v1.root[0] - b.root[0])} triad ${pt(v1.triad[0] - b.triad[0])}]`,
      );
    }
    for (const [name, groups] of Object.entries(results.ablations)) {
      const parts = Object.entries(groups).map(([g, acc]) => {
        const sh = coverageShares(acc);
        return `${g} triad=${pct(sh.triad[0])} root=${pct(sh.root[0])}`;
      });
      console.log(`ABLATION ${name}: ${parts.join(" / ")}`);
    }
    for (const [key, fixtures] of Object.entries(results.fixtureAblations)) {
      for (const f of fixtures) {
        if (f.name.startsWith("Q3-Am") || f.name.startsWith("Q3-B7") || f.name.startsWith("Q2")) {
          console.log(
            `ABLATION-FIX ${key} ${f.name}: ${pct(f.baseline)}→${pct(f.reeval)}` +
              (f.negative ? " (negative)" : ""),
          );
        }
      }
    }
    console.log(
      `step2 consistency: baselineMaxDev=${results.step2Consistency.baselineMaxDev} v1MaxDev=${results.step2Consistency.v1MaxDev}`,
    );

    // 基準5: OFF 不変性（全スイート）と N.C. 変動ゼロ
    expect(results.totals.offInvariantSuites).toBe(results.totals.totalSuites);
    expect(results.totals.ncDeltaMaxSec).toBe(0);
    // 基準5: baseline と v1 の挙動が初回保存値と一致する（履歴の再現可能性）
    expect(results.step2Consistency.baselineMaxDev).toBeLessThan(1e-6);
    expect(results.step2Consistency.v1MaxDev).toBeLessThan(1e-6);
    // bassPc 一致率は全窓で baseline と同一（再評価は bassPc を触らない）
    for (const s of results.suites) {
      for (const f of s.fixtures ?? []) {
        if (f.bassBaseline !== undefined) {
          expect(f.bassReeval, `${s.suite} ${f.name} bass`).toBeCloseTo(f.bassBaseline, 9);
        }
      }
    }

    // 基準3: フィクスチャ関門（ハード）の合否パターンを記録として固定。
    // v2 主構成は Q3-Am（基準 3a）が 05 の両経路で不合格だった
    // （THEORY_ENGINE_STEP2_RETRY.md §4）。それ以外の窓は全て
    // 関門を通った（Q1b・Q3-C の v1 での破壊は解消）。
    const failedGates: string[] = [];
    for (const s of results.suites) {
      for (const f of s.fixtures ?? []) {
        const pass = f.negative
          ? f.reeval <= f.baseline + 1e-9
          : f.reeval >= f.baseline - 1e-9;
        if (!pass) failedGates.push(`${s.suite} | ${f.name}`);
      }
    }
    expect(failedGates.sort()).toEqual(
      [
        "mixture-suno05 | Q3-Am (1:31-1:33)",
        "stems-suno05 | Q3-Am (1:31-1:33)",
      ].sort(),
    );
    // 基準 3b の回復フロア（stems-05 の Q3-B7 ≥ 34%）も不合格
    // だったことを記録として固定する（v2 では回復ゼロ）
    const stems05 = results.suites.find((s) => s.suite === "stems-suno05");
    const b7 = stems05?.fixtures?.find((f) => f.name.startsWith("Q3-B7"));
    expect(b7?.reeval).toBe(0);
  }, 900_000);
});

/**
 * Theory Engine 第2段の測定ラッパー（vitest 経由）。
 * 実行: npm run measure:theory-step2
 * 本体は scripts/measureTheoryStep2.ts。結果は
 * measurements/theory/theory-step2-results.json に書かれる。
 * ここでは事前登録基準のうち構造的なもの（基準5 不変性・N.C. 不変）
 * を assert し、基準3 フィクスチャ関門については「測定で確定した
 * 合否パターンそのもの」を固定する（主構成は関門の一部に不合格
 * であり、その事実を記録として assert する。ジャンル測定で
 * 失敗した基準を expect(...).toBe(false) と固定した先例と同じ）。
 * 品質基準（1・2・4）の判定は結果文書に記録する。
 */
import { describe, expect, it } from "vitest";
import { coverageShares } from "./measureTheoryStep1";
import { runTheoryStep2Measurement } from "./measureTheoryStep2";

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const pt = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}pt`;

describe("Theory Engine 第2段（系列再評価器）", () => {
  it("事前登録基準を検査し、デルタと反転内訳を測る", async () => {
    const results = await runTheoryStep2Measurement();

    for (const s of results.suites) {
      console.log(
        `${s.suite} [${s.path}]: offInvariant=${s.offInvariant} ncDelta=${Math.abs(s.ncReevalSec - s.ncBaselineSec).toFixed(3)}s`,
      );
      if (s.baseline && s.reeval && s.flips) {
        const b = coverageShares(s.baseline);
        const r = coverageShares(s.reeval);
        console.log(
          `  root ${pct(b.root[0])}→${pct(r.root[0])} (${pt(r.root[0] - b.root[0])}) / ` +
            `triad ${pct(b.triad[0])}→${pct(r.triad[0])} (${pt(r.triad[0] - b.triad[0])}) / ` +
            `core ${pct(b.core[0])}→${pct(r.core[0])} (${pt(r.core[0] - b.core[0])})`,
        );
        console.log(
          `  flips: segs=${s.flips.flippedSegments} (truth match ${s.flips.flippedSegTruthMatch} / miss ${s.flips.flippedSegTruthMiss} / n/a ${s.flips.flippedSegNoTruth}) ` +
            `fixed=${s.flips.fixedSec.toFixed(1)}s broken=${s.flips.brokenSec.toFixed(1)}s changedWrong=${s.flips.changedWrongSec.toFixed(1)}s ` +
            `rootFixed=${s.flips.fixedRootSec.toFixed(1)}s rootBroken=${s.flips.brokenRootSec.toFixed(1)}s`,
        );
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
    }
    for (const [name, agg] of Object.entries(results.aggregates)) {
      const b = coverageShares(agg.baseline);
      const r = coverageShares(agg.reeval);
      console.log(
        `AGG ${name}: root ${pct(b.root[0])}→${pct(r.root[0])} (${pt(r.root[0] - b.root[0])}) / ` +
          `triad ${pct(b.triad[0])}→${pct(r.triad[0])} (${pt(r.triad[0] - b.triad[0])}) / ` +
          `core ${pct(b.core[0])}→${pct(r.core[0])} (${pt(r.core[0] - b.core[0])})`,
      );
    }
    for (const [name, groups] of Object.entries(results.sensitivity)) {
      const parts = Object.entries(groups).map(([g, acc]) => {
        const sh = coverageShares(acc);
        return `${g} triad=${pct(sh.triad[0])} root=${pct(sh.root[0])}`;
      });
      console.log(`SENS ${name}: ${parts.join(" / ")}`);
    }
    for (const [name, acc] of Object.entries(results.aggregateArgmax)) {
      const sh = coverageShares(acc);
      console.log(
        `ARGMAX-REF ${name}: root=${pct(sh.root[0])} triad=${pct(sh.triad[0])}`,
      );
    }
    for (const [key, fixtures] of Object.entries(results.fixtureVariants)) {
      for (const f of fixtures) {
        console.log(
          `VARIANT ${key} ${f.name}: ${pct(f.baseline)}→${pct(f.reeval)}` +
            (f.negative ? " (negative)" : ""),
        );
      }
    }

    // 基準5: OFF 不変性（全スイート）と N.C. 変動ゼロ
    expect(results.totals.offInvariantSuites).toBe(results.totals.totalSuites);
    expect(results.totals.ncDeltaMaxSec).toBe(0);

    // 基準3: フィクスチャ関門（ハード）の合否パターンを記録として固定。
    // 主構成は以下の窓で関門に不合格だった（THEORY_ENGINE_STEP2.md §4）。
    // bassPc 一致率は全窓で baseline と同一（再評価は bassPc を
    // 触らない）こともあわせて固定する。
    const failedGates: string[] = [];
    for (const s of results.suites) {
      for (const f of s.fixtures ?? []) {
        const pass = f.negative
          ? f.reeval <= f.baseline + 1e-9
          : f.reeval >= f.baseline - 1e-9;
        if (!pass) failedGates.push(`${s.suite} | ${f.name}`);
        if (f.bassBaseline !== undefined) {
          expect(f.bassReeval, `${s.suite} ${f.name} bass`).toBeCloseTo(
            f.bassBaseline,
            9,
          );
        }
      }
    }
    expect(failedGates.sort()).toEqual(
      [
        "mixture-suno05 | Q1b (1:33-1:38)",
        "mixture-suno05 | Q3-Am (1:31-1:33)",
        "mixture-suno05 | Q3-C (1:25-1:27)",
        "stems-suno05 | Q1b (1:33-1:38)",
        "stems-suno05 | Q3-Am (1:31-1:33)",
        "yoi-arm-b-demucs | Q3-Am (1:31-1:33)",
      ].sort(),
    );
  }, 900_000);
});

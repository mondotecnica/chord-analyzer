/**
 * 音符レベルの証拠選択の診断測定ラッパー（vitest 経由）。
 * 実行: npm run measure:evidence-selection
 * 本体は scripts/measureEvidenceSelection.ts。結果は
 * measurements/notepitch/evidence-selection-results.json に書かれる。
 * 診断 A（純度）・B（仲裁）の合否判定は EVIDENCE_SELECTION.md で
 * 行い、ここでは構造的な健全性（値域・分母の存在）だけを assert
 * する（診断の結論が否定的でも回帰テストとしては合格であるべき
 * ため）。
 */
import { describe, expect, it } from "vitest";
import { runEvidenceSelectionMeasurement } from "./measureEvidenceSelection";

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

describe("音符レベルの証拠選択（診断測定）", () => {
  it("純度と仲裁を測る", async () => {
    const results = await runEvidenceSelectionMeasurement();

    for (const [path, pooled] of Object.entries(results.purity.realPooledByPath)) {
      console.log(
        `purity ${path}: raw=${pct(pooled.raw.purity)} sustain=${pct(pooled.sustain.purity)} melody=${pct(pooled.melody.purity)} both=${pct(pooled.both.purity)}`,
      );
      for (const cond of Object.values(pooled)) {
        expect(cond.purity).toBeGreaterThanOrEqual(0);
        expect(cond.purity).toBeLessThanOrEqual(1);
        expect(cond.denomSec).toBeGreaterThan(0);
      }
    }
    const arb = results.arbitration.pooled;
    console.log(
      `arbitration pooled: disagreements=${arb.disagreementSegments} arbitrable=${arb.arbitrableSec.toFixed(1)}s ` +
        `aggregate=${pct(arb.sources.aggregate.accuracy)} raw=${pct(arb.sources.raw.accuracy)} ` +
        `sustain=${pct(arb.sources.sustain.accuracy)} melody=${pct(arb.sources.melody.accuracy)} ` +
        `both=${pct(arb.sources.both.accuracy)} winnerBaseline=${pct(arb.winnerBaselineAccuracy)} ` +
        `binomial n=${arb.binomialBoth.segments} x=${arb.binomialBoth.correct} p=${arb.binomialBoth.pValue.toFixed(4)}`,
    );
    expect(arb.disagreementSegments).toBeGreaterThan(0);
    expect(arb.arbitrableSec).toBeGreaterThan(0);
    for (const src of Object.values(arb.sources)) {
      expect(src.accuracy).toBeGreaterThanOrEqual(0);
      expect(src.accuracy).toBeLessThanOrEqual(1);
    }
  }, 900_000);
});

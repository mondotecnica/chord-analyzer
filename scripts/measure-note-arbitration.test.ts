/**
 * 音符仲裁を主軸にした再評価器の測定ラッパー（vitest 経由）。
 * 実行: npm run measure:note-arbitration
 * 本体は scripts/measureNoteArbitration.ts。結果は
 * measurements/theory/theory-note-arbitration-results.json に書かれる。
 * ここでは事前登録基準のうち構造的なもの（基準5: OFF／無入力の
 * 不変性・N.C. 不変・初回保存値との一致・製品接続の一致）を
 * assert する。品質基準（1〜4）とフィクスチャ関門（基準3）の
 * 判定は結果文書に記録し、関門の合否パターンは測定で確定した
 * ものを記録として固定する（第2段の先例と同じ）。
 */
import { describe, expect, it } from "vitest";
import { coverageShares } from "./measureTheoryStep1";
import { runNoteArbitrationMeasurement } from "./measureNoteArbitration";

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const pt = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}pt`;

describe("音符仲裁を主軸にした再評価器", () => {
  it("事前登録基準を検査し、デルタと反転内訳を測る", async () => {
    const results = await runNoteArbitrationMeasurement();

    for (const s of results.suites) {
      console.log(
        `${s.suite} [${s.path}]: notes=${s.notesAvailable} offInvariant=${s.offInvariant} noNotesInvariant=${s.noNotesInvariant} ncDelta=${Math.abs(s.ncReevalSec - s.ncBaselineSec).toFixed(3)}s`,
      );
      if (s.baseline && s.reeval && s.flips) {
        const b = coverageShares(s.baseline);
        const r = coverageShares(s.reeval);
        const a = s.ablation ? coverageShares(s.ablation) : null;
        console.log(
          `  root ${pct(b.root[0])}→${pct(r.root[0])} (${pt(r.root[0] - b.root[0])}) / ` +
            `triad ${pct(b.triad[0])}→${pct(r.triad[0])} (${pt(r.triad[0] - b.triad[0])}) / ` +
            `core ${pct(b.core[0])}→${pct(r.core[0])} (${pt(r.core[0] - b.core[0])})` +
            (a ? `  [理論補助OFF triad ${pct(a.triad[0])}]` : ""),
        );
        console.log(
          `  flips: segs=${s.flips.flippedSegments} fixed=${s.flips.fixedSec.toFixed(1)}s broken=${s.flips.brokenSec.toFixed(1)}s changedWrong=${s.flips.changedWrongSec.toFixed(1)}s ` +
            `sources: notes=${s.sources.notesSegments}seg/${s.sources.notesSec.toFixed(1)}s theory=${s.sources.theorySegments}seg/${s.sources.theorySec.toFixed(1)}s`,
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
      for (const f of s.fixturesAblation ?? []) {
        if (f.name.startsWith("Q3-Am") || f.name.startsWith("Q3-B7") || f.name.startsWith("Q2")) {
          console.log(
            `  fixture(理論補助OFF) ${f.name}: ${pct(f.baseline)}→${pct(f.reeval)}` +
              (f.negative ? " (negative)" : ""),
          );
        }
      }
    }
    for (const [name, agg] of Object.entries(results.aggregates)) {
      const b = coverageShares(agg.baseline);
      const r = coverageShares(agg.reeval);
      const a = coverageShares(agg.ablation);
      console.log(
        `AGG ${name}: root ${pct(b.root[0])}→${pct(r.root[0])} (${pt(r.root[0] - b.root[0])}) / ` +
          `triad ${pct(b.triad[0])}→${pct(r.triad[0])} (${pt(r.triad[0] - b.triad[0])}) / ` +
          `core ${pct(b.core[0])}→${pct(r.core[0])} (${pt(r.core[0] - b.core[0])}) / ` +
          `[理論補助OFF root ${pt(a.root[0] - b.root[0])} triad ${pt(a.triad[0] - b.triad[0])}]`,
      );
    }
    for (const w of results.wiringChecks) {
      console.log(`wiring ${w.suite}: labelsMatch=${w.labelsMatch}`);
    }
    console.log(
      `step2 consistency: baselineMaxDev=${results.step2Consistency.baselineMaxDev} v1MaxDev=${results.step2Consistency.v1MaxDev}`,
    );

    // 基準5(a)(b): OFF／無入力の不変性（全スイート）
    expect(results.totals.offInvariantSuites).toBe(results.totals.totalSuites);
    expect(results.totals.noNotesInvariantSuites).toBe(results.totals.totalSuites);
    // 基準5(c): N.C. 変動ゼロ
    expect(results.totals.ncDeltaMaxSec).toBe(0);
    // 基準5(d): baseline と v1 の挙動が初回保存値と一致する
    expect(results.step2Consistency.baselineMaxDev).toBeLessThan(1e-6);
    expect(results.step2Consistency.v1MaxDev).toBeLessThan(1e-6);
    // 製品接続（実経路）と純粋関数適用のラベル一致
    for (const w of results.wiringChecks) {
      expect(w.labelsMatch, `wiring ${w.suite}`).toBe(true);
    }
    // bassPc 一致率は全窓で baseline と同一（再評価は bassPc を触らない）
    for (const s of results.suites) {
      for (const f of s.fixtures ?? []) {
        if (f.bassBaseline !== undefined) {
          expect(f.bassReeval, `${s.suite} ${f.name} bass`).toBeCloseTo(f.bassBaseline, 9);
        }
      }
    }

    // 基準3: フィクスチャ関門（ハード）の合否パターンを記録として
    // 固定する（記入は測定結果の確定後。THEORY_ENGINE_NOTE_
    // ARBITRATION.md §4 参照）
    const failedGates: string[] = [];
    for (const s of results.suites) {
      for (const f of s.fixtures ?? []) {
        const pass = f.negative
          ? f.reeval <= f.baseline + 1e-9
          : f.reeval >= f.baseline - 1e-9;
        if (!pass) failedGates.push(`${s.suite} | ${f.name}`);
      }
    }
    expect(failedGates.sort()).toEqual([].sort());
    // 基準 3b の回復フロア（stems-05 の Q3-B7 ≥ 34%）
    const stems05 = results.suites.find((s) => s.suite === "stems-suno05");
    const b7 = stems05?.fixtures?.find((f) => f.name.startsWith("Q3-B7"));
    expect(b7?.reeval).toBeGreaterThanOrEqual(0.34);
  }, 900_000);
});

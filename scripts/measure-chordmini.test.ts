/**
 * Phase 4 Stage 1: ChordMini 測定ラッパー（vitest 経由）。
 * 実行: npm run measure:chordmini
 * 本体は scripts/measureChordMini.ts。結果は
 * measurements/phase4/chordmini-results.json に書かれる。
 * 合否の判定は事前登録（CHORDMINI_STAGE1.md §0）に基づき結果文書で行うため、
 * ここでは測定の完走と要約の表示のみを行う（数値で assert しない）。
 */
import { describe, it } from "vitest";
import { runChordMiniMeasurement } from "./measureChordMini";

const pct = (x: number | null) => (x === null ? "—" : `${(x * 100).toFixed(1)}%`);

describe("Phase 4 Stage 1: ChordMini 測定", () => {
  it("実曲3曲＋Suno 05 を測定する", async () => {
    const results = await runChordMiniMeasurement();
    for (const song of results.real) {
      const b = song.baselines;
      console.log(
        `${song.slug}: default-mix ${pct(b.defaultMix.rootAccuracy)}/${pct(b.defaultMix.triadAccuracy)}/${pct(b.defaultMix.coreAccuracy)}` +
          ` | stems ${pct(b.stemsCurrent.rootAccuracy)}/${pct(b.stemsCurrent.triadAccuracy)}/${pct(b.stemsCurrent.coreAccuracy)}`,
      );
      for (const [id, m] of Object.entries(song.chordmini)) {
        console.log(
          `  chordmini-${id}: ${pct(m.rootAccuracy)}/${pct(m.triadAccuracy)}/${pct(m.coreAccuracy)} (N.C. ${pct(m.ncShare)})`,
        );
      }
    }
    const arb = results.arbitration.pooled;
    console.log(
      `仲裁: aggregate ${pct(arb.aggregateAccuracy)} / winner ${pct(arb.winnerBaselineAccuracy)} / chordmini ${pct(arb.chordminiAccuracy)} (denom ${arb.chordminiDenomSec.toFixed(1)}s)`,
    );
    for (const [id, input] of Object.entries(results.suno05.inputs)) {
      const q3 = Object.entries(input.q3SubWindows)
        .map(([k, v]) => `${k}=${v.majority?.label ?? "—"}(${(v.triadShare * 100).toFixed(0)}%)`)
        .join(" ");
      const q2total = Object.values(input.q2CMinor).reduce((a, x) => a + x, 0);
      console.log(`suno05-${id}: N.C. ${pct(input.ncShare)} | ${q3} | Q2 C-minor系 ${q2total.toFixed(2)}s`);
    }
  }, 3_600_000);
});

/**
 * Phase 3.1 測定テスト（二段判定・第2段＝拡張音検出の OFF/ON 比較）。
 *
 * ここで assert するのは「コードの正しさの不変条件」:
 * - 第2段 OFF が記録済みベースライン（PHASE1_SUMMARY / STEM_BAND_AB /
 *   PHASE3_SONG_E_BASELINE）を再現すること（第1段に触れていない証明）。
 * - 合成曲 E/F で拡張音の指標が大きく改善すること。
 * - Suno フィクスチャ Q3（C→B7→E7→Am）が stems 経路で読めること。
 * - 第2段が三和音コアを壊さないこと（ON の root/triad/core が OFF から
 *   0.5pt 以上落ちない。計画の採用基準は「記録値を下回らない」であり、
 *   判定そのものは measurements/phase3/PHASE3_1_RESULTS.md に置く）。
 * - Q2 窓の Cm 秒数が第2段で増減しないこと（第2段はコアを直さない）。
 *
 * 実行すると measurements/phase3/phase3-1-*.json を書き出す。
 */
import { describe, expect, it } from "vitest";
import {
  runPhase3RealMixture,
  runPhase3RealStems,
  runPhase3Synthetic,
  runPhase3Suno,
} from "./measurePhase3";

const TOL = 0.0015; // 記録値（小数1桁 %）との照合用
const GUARD = 0.005; // コア指標の劣化トリップワイヤ（0.5pt）

describe("Phase 3.1 測定", () => {
  it("合成曲 A–F: OFF ベースライン再現と ON の拡張音改善", async () => {
    const entries = await runPhase3Synthetic();
    const byId = new Map(entries.map((e) => [e.songId, e]));

    // Song E の OFF は PHASE3_SONG_E_BASELINE.md の記録値
    const e = byId.get("song-e")!;
    expect(e.off.rootAccuracy).toBeCloseTo(0.917, 2);
    expect(e.off.triadAccuracy).toBeCloseTo(0.885, 2);
    // 第2段で 7th が読めるようになる
    expect(e.extOn.fullLabelAccuracy).toBeGreaterThan(0.75);
    expect(e.extOn.seventhGivenCore).toBeGreaterThan(0.85);
    expect(e.extOn.fullLabelAccuracy).toBeGreaterThan(e.extOff.fullLabelAccuracy);

    const f = byId.get("song-f")!;
    expect(f.extOn.fullLabelAccuracy).toBeGreaterThan(0.65);
    expect(f.extOn.seventhGivenCore).toBeGreaterThan(0.65);
    expect(f.extOn.falseFireRate).toBeLessThan(0.01);

    // 三和音の対照曲では誤発火しない＆コアは不変
    for (const id of ["song-a", "song-b", "song-c"]) {
      const s = byId.get(id)!;
      expect(s.extOn.falseFireRate).toBeLessThan(0.01);
      expect(s.on.rootAccuracy).toBeGreaterThanOrEqual(s.off.rootAccuracy - 0.001);
      expect(s.on.triadAccuracy).toBeGreaterThanOrEqual(s.off.triadAccuracy - 0.001);
    }
    // 全曲でコア劣化なし
    for (const s of entries) {
      expect(s.on.rootAccuracy).toBeGreaterThanOrEqual(s.off.rootAccuracy - 0.001);
      expect(s.on.triadAccuracy).toBeGreaterThanOrEqual(s.off.triadAccuracy - 0.001);
    }
  }, 600_000);

  it("実曲 混合音: OFF が PHASE1 記録値を再現し、ON もコアを壊さない", async () => {
    const entries = await runPhase3RealMixture();
    const recorded: Record<string, [number, number, number]> = {
      "put-your-records-on": [0.541, 0.642, 0.311],
      everything: [0.227, 0.316, 0.139],
      "a-hard-days-night": [0.281, 0.226, 0.36],
    };
    for (const e of entries) {
      const rec = recorded[e.slug];
      expect(e.mixOff).not.toBeNull();
      expect(Math.abs(e.mixOff!.rootAccuracy - rec[0])).toBeLessThan(TOL);
      expect(Math.abs(e.mixOff!.triadAccuracy - rec[1])).toBeLessThan(TOL);
      expect(Math.abs(e.mixOff!.coreAccuracy - rec[2])).toBeLessThan(TOL);
      expect(e.mixOn!.rootAccuracy).toBeGreaterThanOrEqual(e.mixOff!.rootAccuracy - GUARD);
      expect(e.mixOn!.triadAccuracy).toBeGreaterThanOrEqual(e.mixOff!.triadAccuracy - GUARD);
      expect(e.mixOn!.coreAccuracy).toBeGreaterThanOrEqual(e.mixOff!.coreAccuracy - GUARD);
    }
    // 曲1・曲2 の混合音では完全ラベルが改善する。曲3（AHDN）は属音への引力で
    // コアが既に誤っている区間に 7th が乗るため完全ラベルが下がる
    // （既知の所見として PHASE3_1_RESULTS.md に記録。ここでは assert しない）
    const s1 = entries.find((e) => e.slug === "put-your-records-on")!;
    const s2 = entries.find((e) => e.slug === "everything")!;
    expect(s1.mixExtOn!.fullLabelAccuracy).toBeGreaterThan(s1.mixExtOff!.fullLabelAccuracy);
    expect(s2.mixExtOn!.fullLabelAccuracy).toBeGreaterThan(s2.mixExtOff!.fullLabelAccuracy);
  }, 900_000);

  it("実曲 ステム: OFF が STEM_BAND_AB 記録値を再現し、ON もコアを壊さない", async () => {
    const entries = await runPhase3RealStems();
    const recorded: Record<string, [number, number, number]> = {
      "put-your-records-on": [0.614, 0.817, 0.383],
      everything: [0.271, 0.371, 0.207],
      "a-hard-days-night": [0.506, 0.517, 0.347],
    };
    for (const e of entries) {
      expect(e.stemsOff).not.toBeNull();
      if (e.slug === "song-d") {
        // Song D ステムの番人（STEM_BAND_AB: ルート 98.6%）
        expect(e.stemsOff!.rootAccuracy).toBeCloseTo(0.986, 2);
        expect(e.stemsOn!.rootAccuracy).toBeCloseTo(e.stemsOff!.rootAccuracy, 3);
        expect(e.stemsExtOn!.falseFireRate).toBeLessThan(0.01);
        continue;
      }
      const rec = recorded[e.slug];
      expect(Math.abs(e.stemsOff!.rootAccuracy - rec[0])).toBeLessThan(TOL);
      expect(Math.abs(e.stemsOff!.triadAccuracy - rec[1])).toBeLessThan(TOL);
      expect(Math.abs(e.stemsOff!.coreAccuracy - rec[2])).toBeLessThan(TOL);
      expect(e.stemsOn!.rootAccuracy).toBeGreaterThanOrEqual(e.stemsOff!.rootAccuracy - GUARD);
      expect(e.stemsOn!.triadAccuracy).toBeGreaterThanOrEqual(e.stemsOff!.triadAccuracy - GUARD);
      expect(e.stemsOn!.coreAccuracy).toBeGreaterThanOrEqual(e.stemsOff!.coreAccuracy - GUARD);
    }
    // 曲1・曲2 では完全ラベルが実際に改善する（7th が機能的に使われる曲）
    const s1 = entries.find((e) => e.slug === "put-your-records-on")!;
    const s2 = entries.find((e) => e.slug === "everything")!;
    expect(s1.stemsExtOn!.fullLabelAccuracy).toBeGreaterThan(s1.stemsExtOff!.fullLabelAccuracy);
    expect(s2.stemsExtOn!.fullLabelAccuracy).toBeGreaterThan(s2.stemsExtOff!.fullLabelAccuracy);
    expect(s1.stemsExtOn!.seventhGivenCore).toBeGreaterThan(0.8);
    expect(s2.stemsExtOn!.seventhGivenCore).toBeGreaterThan(0.8);
  }, 900_000);

  it("Suno 05 フィクスチャ: Q3 が読め、Q2 の Cm は第2段で不変、Q1 の層は壊れない", async () => {
    const run = await runPhase3Suno();
    const f = run.fixtures;
    // Q3（第一回帰テスト）: stems 経路で C → B7 → E7 → Am
    expect(f.q3.pass).toBe(true);
    // Q2: 第2段は Cm 秒数を変えない（直すのも悪化させるのも第2段の仕事ではない。
    // Cm そのものの残存＝第1段の問題は PHASE3_1_RESULTS.md で判定する）
    expect(f.q2.stemsCmSecOn).toBeCloseTo(f.q2.stemsCmSecOff, 6);
    expect(f.q2.mixCmSecOn).toBeCloseTo(f.q2.mixCmSecOff, 6);
    // Q1: 支配的セグメントのベース（D）とルートは第2段で壊れない
    for (const w of f.q1.windows) {
      expect(w.stemsDominantOn?.bassPc).toBe(2);
      expect(w.stemsDominantOn?.chord).toBe(w.stemsDominantOff?.chord);
    }
  }, 900_000);
});

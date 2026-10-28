import { describe, expect, it } from "vitest";
import {
  runMeterRealMixture,
  runMeterRealStems,
  runMeterSuno,
  runMeterSynthetic,
  writeMeterInvariance,
} from "./measurePhaseMeter";

/**
 * Phase 3 §5（拍子・小節推定）の測定ドライバ。
 * 生成物: measurements/phase3/phase3-meter-*.json
 * 判定と考察: measurements/phase3/PHASE3_METER_RESULTS.md
 *
 * ここでの assert は 3.1／3.3／ジャンルと同じく「ベースライン再現」
 * 「記録のラベル不変性（基準 C7 の証明）」「フィクスチャ不変
 * （基準 C8 の番人）」に限る。事前登録基準 C1–C6 への合否判定は
 * 結果文書に人間が書く。
 */

const TOL = 0.0015;

function close(actual: number, expected: number) {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(TOL);
}

describe("Phase 3 §5: 合成曲の拍子測定", () => {
  it("全アームを測定し、記録アームでのみ拍子推定が記録される", async () => {
    const entries = await runMeterSynthetic();
    expect(entries.length).toBe(9);
    for (const entry of entries) {
      expect(entry.arms.off.meter, entry.songId).toBeNull();
      expect(entry.arms.rec.meter, entry.songId).not.toBeNull();
      // 既定（def）は採用判定の結果、記録 OFF（明示オプトイン）
      expect(entry.arms.def.meter, entry.songId).toBeNull();
      // 記録のみ（rec）では bpm は検出値のまま変わらない
      expect(entry.arms.rec.resultBpm, entry.songId).toBe(
        entry.arms.off.resultBpm,
      );
      expect(entry.arms.def.resultBpm, entry.songId).toBe(
        entry.arms.off.resultBpm,
      );
    }
  }, 1_800_000);
});

describe("Phase 3 §5: 実曲の拍子測定（混合音）", () => {
  it("off が Phase 3 記録ベースラインを再現する", async () => {
    const entries = await runMeterRealMixture();
    const bySlug = new Map(entries.map((e) => [e.slug, e]));
    const recorded: Record<string, [number, number, number]> = {
      "put-your-records-on": [0.541, 0.642, 0.311],
      everything: [0.227, 0.316, 0.139],
      "a-hard-days-night": [0.281, 0.226, 0.36],
    };
    for (const [slug, [root, triad, core]] of Object.entries(recorded)) {
      const off = bySlug.get(slug)!.measurements.off!;
      close(off.rootAccuracy, root);
      close(off.triadAccuracy, triad);
      close(off.coreAccuracy, core);
      expect(bySlug.get(slug)!.arms.rec.meter, slug).not.toBeNull();
    }
  }, 1_800_000);
});

describe("Phase 3 §5: 実曲の拍子測定（ステム）", () => {
  it("off が記録ベースラインを再現し、Song D の守りが崩れていない", async () => {
    const entries = await runMeterRealStems();
    const bySlug = new Map(entries.map((e) => [e.slug, e]));
    const recorded: Record<string, [number, number, number]> = {
      "put-your-records-on": [0.614, 0.817, 0.383],
      everything: [0.271, 0.371, 0.207],
      "a-hard-days-night": [0.506, 0.517, 0.347],
    };
    for (const [slug, [root, triad, core]] of Object.entries(recorded)) {
      const off = bySlug.get(slug)!.measurements.off!;
      close(off.rootAccuracy, root);
      close(off.triadAccuracy, triad);
      close(off.coreAccuracy, core);
      expect(bySlug.get(slug)!.arms.rec.meter, slug).not.toBeNull();
    }
    const songD = bySlug.get("song-d")!;
    expect(songD.measurements.off!.rootAccuracy).toBeGreaterThanOrEqual(0.98);
  }, 1_800_000);
});

describe("Phase 3 §5: Suno フィクスチャ", () => {
  it("両モードで拍子推定が記録され、フィクスチャが meter で変わらない（C8）", async () => {
    const run = await runMeterSuno();
    expect(run.mixArms.rec.meter).not.toBeNull();
    expect(run.stemsArms.rec.meter).not.toBeNull();
    expect(run.stemsArms.rec.meter!.onsetSource).toBe("drums");
    // 3.1 の記録値の再現（phase3-1-suno.json）:
    // Q3 合格、Q2 は Cm 4.75 秒（第1段由来）で stage2Pass は false、Q1 も false
    expect(run.fixturesDefault.q3.pass).toBe(true);
    expect(run.fixturesDefault.q2.stemsCmSecOn).toBeCloseTo(4.75, 6);
    expect(run.fixturesDefault.q2.stage2Pass).toBe(false);
    expect(run.fixturesDefault.q1.pass).toBe(false);
    // meter の有無でフィクスチャ判定は完全一致しなければならない
    expect(JSON.stringify(run.fixturesMeterOff)).toBe(
      JSON.stringify(run.fixturesDefault),
    );
  }, 1_800_000);
});

describe("Phase 3 §5: 記録のラベル不変性（基準 C7）", () => {
  it("記録 ON（rec）と meterRecord: false でラベル＋キーが完全一致する", async () => {
    const entries = writeMeterInvariance();
    // 合成9＋実曲 混合音3＋ステム4（Song D 含む）＋Suno 2 = 18 スイート
    expect(entries.length).toBe(18);
    for (const e of entries) {
      expect(e.meterPresentInRecordArm, e.suite).toBe(true);
      expect(e.diffs, e.suite).toBe(0);
      // bpm の差は仲裁（スケール ≠ 1）によるものだけが許される
      expect(e.bpmDiffExplainedByArbitration, e.suite).toBe(true);
    }
  }, 1_800_000);
});

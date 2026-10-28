import { describe, expect, it } from "vitest";
import {
  runGenreInvariance,
  runGenreRealMixture,
  runGenreRealStems,
  runGenreSuno,
  runGenreSynthetic,
} from "./measurePhaseGenre";

/**
 * Phase 3 後半（ジャンル傾向＝様式プロファイル）の測定ドライバ。
 * 生成物: measurements/phase3/phase3-genre-*.json
 * 判定と考察: measurements/phase3/PHASE3_GENRE_RESULTS.md
 *
 * ここでの assert は 3.1／3.3 と同じく「ベースライン再現」「記録の
 * ラベル不変性（基準7の証明）」「守りの番人（コア指標の下限）」
 * に限る。事前登録基準への合否判定は結果文書に人間が書く。
 */

const TOL = 0.0015;

function close(actual: number, expected: number) {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(TOL);
}

describe("Phase 3 後半: 合成曲ジャンル測定", () => {
  it("全アームを測定し、off がベースラインを再現する", async () => {
    const entries = await runGenreSynthetic();
    const byId = new Map(entries.map((e) => [e.songId, e]));

    // Phase 3.1 で記録した off ベースライン（Song E: ルート 0.917 / 三和音 0.885）
    const e = byId.get("song-e")!;
    close(e.arms.off.rootAccuracy, 0.917);
    close(e.arms.off.triadAccuracy, 0.885);

    // 全曲で様式プロファイルが記録される（合計 ≒ 1）
    for (const entry of entries) {
      expect(entry.profile, entry.songId).not.toBeNull();
      const sum = entry.profile!.scores.reduce((a, s) => a + s.score, 0);
      expect(Math.abs(sum - 1)).toBeLessThan(1e-6);
    }

    // Song I（♭VII ロック）: 三和音のみの正解に拡張音が誤発火しない（基準6の番人）
    const iSong = byId.get("song-i")!;
    for (const arm of ["ext", "ext33", "extG", "extG33"] as const) {
      expect(iSong.extArms[arm].falseFireRate, `song-i ${arm}`).toBe(0);
    }
  }, 1_800_000);
});

describe("Phase 3 後半: 実曲ジャンル測定（混合音）", () => {
  it("off が Phase 3 記録ベースラインを再現し、extG が守りの範囲内にある", async () => {
    const entries = await runGenreRealMixture();
    const bySlug = new Map(entries.map((e) => [e.slug, e]));

    const recorded: Record<string, [number, number, number]> = {
      "put-your-records-on": [0.541, 0.642, 0.311],
      everything: [0.227, 0.316, 0.139],
      "a-hard-days-night": [0.281, 0.226, 0.36],
    };
    for (const [slug, [root, triad, core]] of Object.entries(recorded)) {
      const off = bySlug.get(slug)!.arms.off!;
      close(off.rootAccuracy, root);
      close(off.triadAccuracy, triad);
      close(off.coreAccuracy, core);

      // 基準2の番人（ジャンルの純効果の切り分け）: extG は対応する
      // 非ジャンルアーム ext とのコア指標差が 0.5pt 以内であること。
      // ext アーム自体との比較（登録基準2の判定）は結果文書で行う
      for (const [key] of [
        ["rootAccuracy"],
        ["triadAccuracy"],
        ["coreAccuracy"],
      ] as const) {
        const base = bySlug.get(slug)!.arms.ext![key];
        const value = bySlug.get(slug)!.arms.extG![key];
        expect(
          Math.abs(value - base),
          `${slug} extG vs ext ${key}`,
        ).toBeLessThanOrEqual(0.005);
      }
    }
  }, 1_800_000);
});

describe("Phase 3 後半: 実曲ジャンル測定（ステム）", () => {
  it("off が記録ベースラインを再現し、コア指標が守りの範囲内にある", async () => {
    const entries = await runGenreRealStems();
    const bySlug = new Map(entries.map((e) => [e.slug, e]));

    const recorded: Record<string, [number, number, number]> = {
      "put-your-records-on": [0.614, 0.817, 0.383],
      everything: [0.271, 0.371, 0.207],
      "a-hard-days-night": [0.506, 0.517, 0.347],
    };
    for (const [slug, [root, triad, core]] of Object.entries(recorded)) {
      const off = bySlug.get(slug)!.arms.off!;
      close(off.rootAccuracy, root);
      close(off.triadAccuracy, triad);
      close(off.coreAccuracy, core);
      // ジャンルの純効果の番人: 各ジャンルアームは対応する
      // 非ジャンルアーム（extG↔ext、extG33↔ext33）とコア指標で
      // 0.5pt 以内の差に収まること（登録基準2の判定は結果文書）
      for (const [arm, baseArm] of [
        ["extG", "ext"],
        ["extG33", "ext33"],
      ] as const) {
        for (const key of ["rootAccuracy", "triadAccuracy", "coreAccuracy"] as const) {
          const base = bySlug.get(slug)!.arms[baseArm]![key];
          const value = bySlug.get(slug)!.arms[arm]![key];
          expect(
            Math.abs(value - base),
            `${slug} ${arm} vs ${baseArm} ${key}`,
          ).toBeLessThanOrEqual(0.005);
        }
      }
    }

    // Song D の守りの番人（ stems 合成の三和音精度が崩れていない）
    const songD = bySlug.get("song-d")!;
    expect(songD.arms.off!.rootAccuracy).toBeGreaterThanOrEqual(0.98);

    // 全曲でプロファイルが記録され、ステム経路では追加チャンネルも生きる
    for (const entry of entries) {
      expect(entry.profile, entry.slug).not.toBeNull();
      expect(entry.profile!.channels.melody, entry.slug).toBe(true);
      expect(entry.profile!.channels.timbre, entry.slug).toBe(true);
    }
  }, 1_800_000);
});

describe("Phase 3 後半: Suno フィクスチャ", () => {
  it("ext アームが 3.1 の記録を再現し、ジャンルがフィクスチャを変えない", async () => {
    const run = await runGenreSuno();
    // ext アーム＝3.1 の条件。phase3-1-suno.json の記録値と一致すること:
    // Q3 合格、Q2 は Cm 4.75 秒（第1段由来）で stage2Pass は当時も false
    // （窓内の Cm に m7 が付くため）、Q1 の pass も当時から false
    expect(run.fixturesExt.q3.pass).toBe(true);
    expect(run.fixturesExt.q2.stemsCmSecOn).toBeCloseTo(4.75, 6);
    expect(run.fixturesExt.q2.stage2Pass).toBe(false);
    expect(run.fixturesExt.q1.pass).toBe(false);
    // ジャンルアームはフィクスチャ判定を ext から変えない（基準5の番人。
    // 登録基準への合否そのものは結果文書で判定する）
    expect(run.fixturesExtG.q3.pass).toBe(run.fixturesExt.q3.pass);
    expect(run.fixturesExtG.q1.pass).toBe(run.fixturesExt.q1.pass);
    expect(run.fixturesExtG.q2.stemsCmSecOn).toBeCloseTo(
      run.fixturesExt.q2.stemsCmSecOn,
      6,
    );
    expect(run.fixturesExtG.q2.stage2Pass).toBe(run.fixturesExt.q2.stage2Pass);
    // 様式プロファイルは両経路で記録される（extG は消費部 ON の
    // ため記録も自動で付く。ハーネスのラッパーも記録 ON 固定）
    expect(run.mixProfile).not.toBeNull();
    expect(run.stemsProfile).not.toBeNull();
  }, 1_800_000);
});

describe("Phase 3 後半: 記録のラベル不変性（基準7）", () => {
  it("記録 ON（ハーネスで明示固定）と genreRecord: false でラベルが完全一致する", async () => {
    const entries = await runGenreInvariance();
    // 合成9＋実曲（混合音・ステム）8＋Suno 2 = 19 スイート
    expect(entries.length).toBe(19);
    for (const e of entries) {
      expect(e.profilePresentInDefault, e.suite).toBe(true);
      expect(e.diffs, e.suite).toBe(0);
    }
  }, 1_800_000);
});

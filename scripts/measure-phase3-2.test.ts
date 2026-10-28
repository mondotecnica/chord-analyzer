/**
 * Phase 3.2 測定テスト（分数コードの層表示）。
 *
 * ここで assert するのは不変条件とフィクスチャのみ:
 * - Suno フィクスチャ Q1（C/D 相当）・Q4（CM7/C#）・Q3（C→B7→E7→Am7、
 *   stems＋拡張 ON）が合格すること。
 * - 合成 Song G（add9 専用曲）の全小節チェックが合格すること。
 * - 合成 A–F の表示が一切変わらないこと（層は証拠のある場所にだけ出る）。
 * - 実曲の表示一致率（正解譜の表示名との時間一致）が、既定アームで
 *   1.5pt、拡張アームで 4pt を超えて悪化しないこと。Song D 混合音は
 *   15pt 以上改善すること（正解自体が分数コードの曲）。
 * コードラベル（chord / extension / bassPc / 境界）の不変性は、
 * 3.2 着手前の git HEAD で取得した全32ランのキャプチャとの差分で
 * 開発時に検証した（差分 0 件。手順と結果は PHASE3_2_RESULTS.md）。
 * 採用可否の判定は measurements/phase3/PHASE3_2_RESULTS.md で行う。
 *
 * 実行すると measurements/phase3/phase3-2-*.json を書き出す。
 * 使い方: npm run measure:phase32
 */
import { describe, expect, it } from "vitest";
import {
  captureAll,
  displayAfter,
  evaluateSuno32,
  runRealDisplayAgreement,
  runSongG,
  runSuno32,
  writePhase32Json,
} from "./measurePhase32";

describe("Phase 3.2 測定", () => {
  it("Suno フィクスチャ Q1 / Q4 / Q3 が合格する", async () => {
    const fixtures = evaluateSuno32(await runSuno32());
    writePhase32Json("phase3-2-suno.json", fixtures);
    // eslint-disable-next-line no-console
    console.log("[3.2 suno]", JSON.stringify(fixtures));
    expect(fixtures.q1.pass).toBe(true);
    expect(fixtures.q4.pass).toBe(true);
    expect(fixtures.q3.pass).toBe(true);
  }, 900_000);

  it("Song G（add9）の全小節チェックが合格する", async () => {
    const checks = await runSongG();
    writePhase32Json("phase3-2-song-g.json", checks);
    for (const c of checks) {
      // eslint-disable-next-line no-console
      console.log(
        `[3.2 song-g] bar ${c.bar} truth=${c.truth} def=${c.displayDefault} ext=${c.displayExt} pass=${c.pass}`,
      );
      expect(c.pass).toBe(true);
    }
  }, 900_000);

  it("合成 A–F の表示は不変、実曲の表示一致率はガード範囲内", async () => {
    const runs = await captureAll();
    // 合成 A–F: 層フィールドが付いても表示は従来と完全一致すること
    for (const run of runs) {
      if (!run.suite.startsWith("synthetic:")) continue;
      if (run.suite === "synthetic:song-g") continue;
      if (run.suite === "synthetic:song-d") continue; // Song D は実曲経路で測る
      for (const s of run.segments) {
        expect(displayAfter(s), `${run.suite}:${run.config}@${s.start}`).toBe(
          s.displayOld,
        );
      }
    }
    const rows = await runRealDisplayAgreement();
    writePhase32Json("phase3-2-real-display.json", rows);
    for (const row of rows) {
      // eslint-disable-next-line no-console
      console.log(
        `[3.2 real-display] ${row.slug}: ` +
          `mix-def ${row.mixDefault ? `${(row.mixDefault.before * 100).toFixed(1)}->${(row.mixDefault.after * 100).toFixed(1)}` : "-"} | ` +
          `mix-ext ${row.mixExt ? `${(row.mixExt.before * 100).toFixed(1)}->${(row.mixExt.after * 100).toFixed(1)}` : "-"} | ` +
          `stems-def ${row.stemsDefault ? `${(row.stemsDefault.before * 100).toFixed(1)}->${(row.stemsDefault.after * 100).toFixed(1)}` : "-"} | ` +
          `stems-ext ${row.stemsExt ? `${(row.stemsExt.before * 100).toFixed(1)}->${(row.stemsExt.after * 100).toFixed(1)}` : "-"}`,
      );
      for (const arm of [row.mixDefault, row.stemsDefault]) {
        if (arm) expect(arm.after).toBeGreaterThanOrEqual(arm.before - 0.015);
      }
      for (const arm of [row.mixExt, row.stemsExt]) {
        if (arm) expect(arm.after).toBeGreaterThanOrEqual(arm.before - 0.04);
      }
      if (row.slug === "song-d" && row.mixDefault) {
        expect(row.mixDefault.after).toBeGreaterThanOrEqual(
          row.mixDefault.before + 0.15,
        );
      }
    }
  }, 900_000);
});

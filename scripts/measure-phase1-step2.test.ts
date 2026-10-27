/**
 * Phase 1 Step 2 測定の実行ハーネス（vitest 経由）。
 * `npm run measure:phase1-step2` で単独実行するのが基本。
 *
 * 生成物:
 * - test-audio/song-d.wav / song-d.groundtruth.json
 * - measurements/PHASE1_STEP2.md / measurements/phase1-step2-results.json
 */
import { describe, expect, it } from "vitest";
import { runPhase1Step2Measurement } from "./measurePhase1Step2";

describe("Phase 1 Step 2 測定（分数コード対応）", () => {
  it("Song D を測定し、Songs A–C の回帰を確認する", async () => {
    const result = await runPhase1Step2Measurement();
    const d = result.songD;
    // eslint-disable-next-line no-console
    console.log(
      `Song D: root ${(d.measurement.rootAccuracy * 100).toFixed(1)}%, triad ${(d.measurement.triadAccuracy * 100).toFixed(1)}%, ` +
        `slash ${(d.slash.slashAccuracy * 100).toFixed(1)}% (${d.slash.slashCorrectSec.toFixed(2)}s/${d.slash.slashExpectedSec.toFixed(2)}s), ` +
        `spurious slash ${d.slash.spuriousSlashSec.toFixed(2)}s`,
    );
    const reg = result.regression;
    // eslint-disable-next-line no-console
    console.log(
      `Regression A–C: root ${(reg.rootAccuracy * 100).toFixed(1)}%, triad ${(reg.triadAccuracy * 100).toFixed(1)}%, spurious slash ${reg.spuriousSlashSec.toFixed(2)}s`,
    );

    // Song D は全区間が分数コード（ベース≠ルート）なので、分数が期待される時間が正であること
    expect(d.slash.slashExpectedSec).toBeGreaterThan(0);
    // 回帰: Step 1 の記録（ルート 95.4% / 三和音 86.4%、四捨五入前の下限）から落ちていないこと
    expect(reg.rootAccuracy).toBeGreaterThanOrEqual(0.9535);
    expect(reg.triadAccuracy).toBeGreaterThanOrEqual(0.8635);
    // 回帰: ベースが常にルートの A–C では分数表示が出ないこと
    expect(reg.spuriousSlashSec).toBe(0);
  }, 300_000);
});

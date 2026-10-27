/**
 * Phase 1.5 分業（hybrid）構成の測定ハーネス（vitest 経由）。
 * `npm run measure:hybrid` で単独実行するのが基本。
 *
 * 生成物:
 * - measurements/hybrid-results.json
 * （レポート measurements/PHASE1_5_HYBRID.md は JSON の数字をもとに作成）
 */
import { describe, expect, it } from "vitest";
import { runHybridMeasurement } from "./measureHybrid";

const pct = (x: number | null) => (x === null ? "—" : `${(x * 100).toFixed(1)}%`);

describe("Phase 1.5 分業（hybrid）の測定", () => {
  it("合成 A–D の回帰と実曲 hybrid の感度を測定する", async () => {
    const result = await runHybridMeasurement();
    const s = result.synthetic;
    expect(s.songs).toHaveLength(4);
    // eslint-disable-next-line no-console
    console.log(
      `hybrid synthetic: A–C root ${pct(s.acRootAccuracy)} / triad ${pct(s.acTriadAccuracy)} / spurious ${s.acSpuriousSlashSec.toFixed(2)}s | ` +
        `Song D root ${pct(s.dRootAccuracy)} / triad ${pct(s.dTriadAccuracy)} / slash ${pct(s.dSlashAccuracy)} / key ${s.dKeyCorrect ? "✓" : "✗"}`,
    );
    for (const song of s.songs) {
      // eslint-disable-next-line no-console
      console.log(
        `  ${song.songId}: root ${pct(song.rootAccuracy)} / triad ${pct(song.triadAccuracy)} / N.C. ${pct(song.ncShare)} / modeFlip ${song.modeFlipSec.toFixed(2)}s`,
      );
    }
    if (result.real) {
      const r = result.real;
      // eslint-disable-next-line no-console
      console.log(
        `hybrid real: root ${pct(r.base.rootAccuracy)} / triad ${pct(r.base.triadAccuracy)} / core ${pct(r.base.coreAccuracy)} / N.C. ${pct(r.base.ncShare)} / key ${r.base.detectedKey} / bpm ${r.base.detectedBpm ?? "—"}`,
      );
      for (const e of r.sensitivity) {
        // eslint-disable-next-line no-console
        console.log(
          `  shift ${e.shiftSec > 0 ? "+" : ""}${e.shiftSec}s: root ${pct(e.rootAccuracy)} / triad ${pct(e.triadAccuracy)} / core ${pct(e.coreAccuracy)}`,
        );
      }
      expect(r.sensitivity).toHaveLength(3);
    } else {
      // eslint-disable-next-line no-console
      console.log("hybrid real: 音声／正解が無いためスキップ");
    }
  }, 600_000);
});

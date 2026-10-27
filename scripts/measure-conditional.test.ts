/**
 * Phase 1.5b 条件分岐（split-conditional）の測定ハーネス（vitest 経由）。
 * `npm run measure:conditional` で単独実行するのが基本。
 *
 * 生成物:
 * - measurements/conditional-results.json
 * （レポート measurements/PHASE1_5B_CONDITIONAL.md は JSON の数字をもとに作成）
 */
import { describe, expect, it } from "vitest";
import { runConditionalMeasurement } from "./measureConditional";

const pct = (x: number | null) => (x === null ? "—" : `${(x * 100).toFixed(1)}%`);

describe("Phase 1.5b 条件分岐（split-conditional）の測定", () => {
  it("合成 A–D の回帰と実曲での発火を測定する", async () => {
    const result = await runConditionalMeasurement();
    const s = result.synthetic;
    expect(s.songs).toHaveLength(4);
    // eslint-disable-next-line no-console
    console.log(
      `conditional synthetic: A–C root ${pct(s.acRootAccuracy)} / triad ${pct(s.acTriadAccuracy)} / spurious ${s.acSpuriousSlashSec.toFixed(2)}s | ` +
        `Song D root ${pct(s.dRootAccuracy)} / triad ${pct(s.dTriadAccuracy)} / slash ${pct(s.dSlashAccuracy)} / key ${s.dKeyCorrect ? "✓" : "✗"}`,
    );
    for (const song of s.songs) {
      // eslint-disable-next-line no-console
      console.log(
        `  ${song.songId}: root ${pct(song.rootAccuracy)} / triad ${pct(song.triadAccuracy)} / fired ${song.firedCount}件 ${song.firedSec.toFixed(2)}s`,
      );
      for (const f of song.fired) {
        // eslint-disable-next-line no-console
        console.log(
          `    fired ${f.startSec.toFixed(1)}-${f.endSec.toFixed(1)}s: ${f.fromChord} → ${f.toChord}（正解 ${f.truthChord ?? "?"}、ルート${f.toRootCorrect ? "一致" : "不一致"}）`,
        );
      }
    }
    if (result.real) {
      const r = result.real;
      // eslint-disable-next-line no-console
      console.log(
        `conditional real: root ${pct(r.conditional.rootAccuracy)} / triad ${pct(r.conditional.triadAccuracy)} / core ${pct(r.conditional.coreAccuracy)} / N.C. ${pct(r.conditional.ncShare)} / key ${r.conditional.detectedKey} / bpm ${r.conditional.detectedBpm ?? "—"} / fired ${r.firedCount}件 ${r.firedSec.toFixed(2)}s`,
      );
      for (const f of r.fired) {
        // eslint-disable-next-line no-console
        console.log(
          `  fired ${f.startSec.toFixed(1)}-${f.endSec.toFixed(1)}s: ${f.fromChord} → ${f.toChord}（正解 ${f.truthChord ?? "?"}、ルート${f.toRootCorrect ? "一致" : "不一致"}）`,
        );
      }
    } else {
      // eslint-disable-next-line no-console
      console.log("conditional real: 音声／正解が無いためスキップ");
    }
  }, 600_000);
});

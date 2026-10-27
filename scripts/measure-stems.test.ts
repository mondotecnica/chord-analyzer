/**
 * Phase 2 プロトタイプ（ステム入力）測定の入口（vitest 経由）。
 * `npm run measure:stems` で単独実行するのが基本。
 * ステム WAV が stem-work/ に無い曲はスキップされるため、
 * 通常の `npm test` でも失敗しない（分離済みの曲だけ測る）。
 *
 * 生成物: measurements/phase2/stems-results.json と
 * measurements/phase2/STEMS_PROTOTYPE.md
 */
import { describe, expect, it } from "vitest";
import { runStemMeasurement, summarizeStemBandAB } from "./measureStems";

const pct = (x: number | null) => (x === null ? "—" : `${(x * 100).toFixed(1)}%`);

describe("Phase 2 プロトタイプ: ステム入力の測定", () => {
  it("分離済みの曲について stems 設定を測定する", async () => {
    const results = await runStemMeasurement();
    for (const r of results) {
      // eslint-disable-next-line no-console
      console.log(
        `${r.slug}: stems root ${pct(r.stems.rootAccuracy)} / triad ${pct(r.stems.triadAccuracy)} / core ${pct(r.stems.coreAccuracy)}` +
          ` | mix-default root ${pct(r.mixDefault.rootAccuracy)} / triad ${pct(r.mixDefault.triadAccuracy)} / core ${pct(r.mixDefault.coreAccuracy)}` +
          ` | bassTopShare stems ${r.sanity.bassTopShareMedian.toFixed(2)} vs mix ${r.sanity.mixTopShareMedian.toFixed(2)}`,
      );
    }
    for (const agg of summarizeStemBandAB(results)) {
      // eslint-disable-next-line no-console
      console.log(
        `[stem-band-ab] ${agg.strategy}: meanScore ${pct(agg.meanScore)} | meanNC ${pct(agg.meanNcShare)} | songD root ${pct(agg.songDRoot)} | bestOrTied ${agg.bestOrTiedSongs}/3`,
      );
    }
    expect(Array.isArray(results)).toBe(true);
  }, 600_000);
});

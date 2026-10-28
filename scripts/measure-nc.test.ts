/**
 * N.C. 解剖（診断）の入口（vitest 経由）。
 * `npm run measure:nc` で単独実行する。
 *
 * assert するのは記録済みベースラインの再現と分類の完全性:
 * - Suno 05 の N.C. 割合が SUNO_05_ANALYSIS.md の記録値
 *   （混合音 5.2% / ステム 22.8%）を再現すること
 * - 実曲1 stems の N.C. 割合が Phase 2 記録（6.9%）を再現すること
 * - 全 N.C. セグメントが4クラスのいずれかに分類され、原因別秒数の
 *   合計が N.C. 総秒数と一致すること
 *
 * 生成物: measurements/nc/nc-anatomy.json
 */
import { describe, expect, it } from "vitest";
import { runNcAnatomy } from "./measureNc";

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

describe("N.C. 解剖", () => {
  it("全スイートの N.C. を原因別に分類し、記録済み N.C. 割合を再現する", async () => {
    const entries = await runNcAnatomy();
    for (const e of entries) {
      const t = e.totals;
      // eslint-disable-next-line no-console
      console.log(
        `${e.suite}/${e.id}: N.C. ${pct(e.ncShare)} (${t.totalSec.toFixed(1)}秒, ${t.segmentCount}件)` +
          ` | routing ${t.byCause.routing.sec.toFixed(1)} / low-energy ${t.byCause["low-energy"].sec.toFixed(1)}` +
          ` / short ${t.byCause.short.sec.toFixed(1)} / score-gate ${t.byCause["score-gate"].sec.toFixed(1)}` +
          (t.recoverableSec !== null
            ? ` | 回収可能 ${t.recoverableSec.toFixed(1)}秒`
            : ""),
      );
      // 分類の完全性: 原因別合計 = N.C. 総秒数（丸め誤差のみ許容）
      const sumByCause = Object.values(t.byCause).reduce((s, c) => s + c.sec, 0);
      expect(Math.abs(sumByCause - t.totalSec)).toBeLessThan(0.1);
      expect(t.segmentCount).toBe(e.records.length);
    }

    const sunoMix = entries.find((e) => e.suite === "suno-mixture")!;
    const sunoStems = entries.find((e) => e.suite === "suno-stems")!;
    expect(sunoMix).toBeTruthy();
    expect(sunoStems).toBeTruthy();
    // SUNO_05_ANALYSIS.md の記録値（小数1桁 %）
    expect(sunoMix.ncShare).toBeCloseTo(0.052, 2);
    expect(sunoStems.ncShare).toBeCloseTo(0.228, 2);

    const song1Stems = entries.find(
      (e) => e.suite === "real-stems" && e.id === "put-your-records-on",
    )!;
    expect(song1Stems).toBeTruthy();
    // Phase 2 記録: stems N.C. 6.9%
    expect(song1Stems.ncShare).toBeCloseTo(0.069, 2);
  }, 900_000);
});

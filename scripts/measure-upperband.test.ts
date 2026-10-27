/**
 * 上帯域クロマ対策の測定ハーネス（vitest 経由）。
 * `npm run measure:upperband` で単独実行するのが基本。
 *
 * 生成物:
 * - measurements/upperband-results.json
 * （レポート measurements/PHASE1_UPPERBAND.md は JSON の数字をもとに作成）
 */
import { describe, expect, it } from "vitest";
import { analyzeAudio } from "../src/analysis/analyze";
import { BAND_VARIANTS, runUpperBandMeasurement } from "./measureUpperBand";
import { measureSong } from "./measureSynthetic";
import { SLASH_SONGS, synthSong } from "./synth";

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

describe("上帯域クロマ対策の測定（バリアント比較）", () => {
  it("全バリアント×4曲を測定し、勝者を選定する", async () => {
    const result = await runUpperBandMeasurement();
    expect(result.variants).toHaveLength(BAND_VARIANTS.length);
    for (const v of result.variants) {
      expect(v.songs).toHaveLength(4);
      // eslint-disable-next-line no-console
      console.log(
        `${v.variant.id} (${v.variant.label}): A–C root ${pct(v.acRootAccuracy)} / triad ${pct(v.acTriadAccuracy)} / spurious ${v.acSpuriousSlashSec.toFixed(2)}s | ` +
          `Song D root ${pct(v.dRootAccuracy)} / triad ${pct(v.dTriadAccuracy)} / slash ${pct(v.dSlashAccuracy)} / key ${v.dKeyCorrect ? "✓" : "✗"}`,
      );
    }
    // eslint-disable-next-line no-console
    console.log(
      `selection: winner=${result.selection.winnerId ?? "none"}; ` +
        result.selection.evaluations
          .map((e) => `${e.variantId}:${e.pass ? "pass" : `fail(${e.reasons.join("; ")})`}`)
          .join(" | "),
    );

    // 対照（全帯域）が Step 1 / Step 2 の記録を再現すること
    const control = result.variants.find((v) => v.variant.id === "off");
    expect(control).toBeDefined();
    expect(control!.acRootAccuracy).toBeGreaterThanOrEqual(0.9535);
    expect(control!.acTriadAccuracy).toBeGreaterThanOrEqual(0.8635);
    expect(control!.acSpuriousSlashSec).toBe(0);
    // 対照の Song D はルート崩壊が再現していること（対策前 26.7%）
    expect(control!.dRootAccuracy).toBeLessThan(0.3);
    expect(control!.dRootAccuracy).toBeGreaterThan(0.25);
  }, 300_000);

  it("既定オプションは分業（split）と同一で、Song D の既知の回帰を含む", async () => {
    const spec = SLASH_SONGS[0];
    const { samples, truth } = synthSong(spec, 44100);
    // オプション未指定 = アプリの既定動作。2026-10-27 の既定変更以降は
    // 「分業（split）」であることをここに固定する
    const defResult = await analyzeAudio(samples, 44100, `${spec.id}.wav`);
    const def = measureSong(truth, defResult);
    const splitResult = await analyzeAudio(samples, 44100, `${spec.id}.wav`, undefined, {
      bassCorrection: true,
      bandStrategy: "split",
    });
    const split = measureSong(truth, splitResult);
    // eslint-disable-next-line no-console
    console.log(
      `default options Song D: root ${(def.rootAccuracy * 100).toFixed(1)}%, triad ${(def.triadAccuracy * 100).toFixed(1)}% (split と同一のはず)`,
    );
    expect(def.rootAccuracy).toBeCloseTo(split.rootAccuracy, 10);
    expect(def.triadAccuracy).toBeCloseTo(split.triadAccuracy, 10);
    // 既定化に際して受け入れた既知の回帰: Song D ルートは split の 26.7%
    expect(def.rootAccuracy).toBeLessThan(0.3);
    expect(def.rootAccuracy).toBeGreaterThan(0.25);
    // unified を明示指定すれば旧既定の改善（87.2%）は引き続き得られる
    const uniResult = await analyzeAudio(samples, 44100, `${spec.id}.wav`, undefined, {
      bassCorrection: true,
      bandStrategy: "unified",
    });
    const uni = measureSong(truth, uniResult);
    expect(uni.rootAccuracy).toBeGreaterThan(0.8);
  }, 300_000);
});

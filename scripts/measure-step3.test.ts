/**
 * Phase 1 Step 3（実曲測定）の測定ハーネス（vitest 経由）。
 * `npm run measure:step3` で単独実行するのが基本。
 *
 * このテスト自体はハーネスの動作確認（スモーク）で、実曲の測定ではない:
 * 正解既知の合成 Song A を 4 設定で回し、配線と 4 設定の区別が
 * 機能することを確認する。生成物 measurements/step3-harness-smoke-results.json
 * はスモーク結果であり、Step 3 の実曲結果ではない。
 *
 * 実曲の測定は scripts/measureStep3.ts の runStep3FromFiles を使う:
 * 1. ffmpeg で MP3 → 16-bit PCM WAV に変換
 * 2. 正解進行 JSON（measurements/step3-truth-TEMPLATE.json の形）を用意
 * 3. runStep3FromFiles(wav, truthJson, outJson) を実行し、
 *    measurements/PHASE1_STEP3.md にレポートを作成する
 */
import { describe, expect, it } from "vitest";
import {
  parseStep3Truth,
  runStep3Measurement,
  splitSlashChord,
  STEP3_VARIANTS,
} from "./measureStep3";
import { SONGS, synthSong } from "./synth";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

describe("Step 3 測定ハーネス", () => {
  it("提案通りの 4 設定が定義されている", () => {
    expect(STEP3_VARIANTS.map((v) => v.id)).toEqual([
      "phase0",
      "bass-only",
      "current",
      "cut220",
    ]);
    const phase0 = STEP3_VARIANTS[0];
    expect(phase0.options.bassCorrection).toBe(false);
    expect(phase0.options.chordBand).toBeNull();
    const current = STEP3_VARIANTS[2];
    expect(current.options.chordBand).toEqual({ cutoffHz: 260, belowWeight: 0 });
    const cut220 = STEP3_VARIANTS[3];
    expect(cut220.options.chordBand).toEqual({ cutoffHz: 220, belowWeight: 0 });
  });

  it("分数コード表記をルートとベースに分ける", () => {
    expect(splitSlashChord("C/E")).toEqual({ chord: "C", bass: "E" });
    expect(splitSlashChord("Am")).toEqual({ chord: "Am" });
    const truth = parseStep3Truth({
      songId: "template-check",
      title: "template",
      key: "C major",
      bpm: 120,
      durationSec: 4,
      segments: [{ startSec: 0, endSec: 4, chord: "C/E" }],
    });
    expect(truth.segments[0]).toMatchObject({ chord: "C", bass: "E", bassPc: 4 });
  });

  it("合成 Song A で 4 設定を回せる（ハーネスのスモーク）", async () => {
    const spec = SONGS[0];
    const { samples, truth } = synthSong(spec, 44100);
    const outPath = join(
      PROJECT_ROOT,
      "measurements",
      "step3-harness-smoke-results.json",
    );
    const result = await runStep3Measurement(samples, 44100, truth, outPath);
    expect(result.variants).toHaveLength(4);
    for (const v of result.variants) {
      // eslint-disable-next-line no-console
      console.log(
        `smoke ${v.variant.id}: Song A root ${pct(v.measurement.rootAccuracy)} / triad ${pct(v.measurement.triadAccuracy)} / key ${v.measurement.detectedKey}`,
      );
    }
    const byId = Object.fromEntries(result.variants.map((v) => [v.variant.id, v.measurement]));
    // 既知の合成ベースライン: Song A のフェーズ0はルート 88.4% 前後
    expect(byId.phase0.rootAccuracy).toBeGreaterThan(0.8);
    // 現在の既定（260Hz＋ベース補正）は合成ではフェーズ0を上回ることが既知
    expect(byId.current.rootAccuracy).toBeGreaterThan(byId.phase0.rootAccuracy);
  }, 300_000);
});

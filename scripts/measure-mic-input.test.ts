/**
 * マイク入力シミュレーション測定。
 * 実行: npx vitest run scripts/measure-mic-input.test.ts
 * 結果は measurements/mic-input/mic-input-results.json、文書は
 * measurements/mic-input/MIC_INPUT_SIM.md。
 * 素材（~/workspace/user/files/ の実曲・05.mp3）が無い環境ではスキップする
 * （他の測定ハーネスと同じ流儀。npm test を壊さないため）。
 */
import { describe, expect, it } from "vitest";
import {
  MIC_CONDITIONS,
  degrade,
  micInputReady,
  runMicInput,
} from "./measureMicInput";

describe("劣化チェーンの健全性（高速）", () => {
  const sr = 44100;
  const x = new Float32Array(sr * 2);
  for (let i = 0; i < x.length; i++) {
    x[i] = 0.5 * Math.sin((2 * Math.PI * 220 * i) / sr);
  }
  it("clean は無加工のコピー", () => {
    const y = degrade(x, sr, MIC_CONDITIONS[0]);
    expect(y).toEqual(x);
    expect(y).not.toBe(x);
  });
  it("劣化条件は決定的で、長さとピークが妥当", () => {
    for (const cond of MIC_CONDITIONS.slice(1)) {
      const a = degrade(x, sr, cond);
      const b = degrade(x, sr, cond);
      expect(a.length).toBe(x.length);
      expect(b.length).toBe(x.length);
      let peak = 0;
      let allFinite = true;
      let identical = true;
      for (let i = 0; i < a.length; i++) {
        if (!Number.isFinite(a[i])) allFinite = false;
        if (a[i] !== b[i]) identical = false;
        peak = Math.max(peak, Math.abs(a[i]));
      }
      expect(allFinite).toBe(true);
      expect(identical).toBe(true);
      expect(peak).toBeLessThanOrEqual(0.950001);
      expect(peak).toBeGreaterThan(0.5);
    }
  }, 60_000);
});

const ready = micInputReady();

describe("マイク入力シミュレーション: 劣化チェーン × 実曲3曲 + Suno 05", () => {
  (ready ? it : it.skip)(
    "4条件 × 4曲を測定し、結果 JSON を書き出す",
    async () => {
      const out = await runMicInput();
      const songs = out.realSongs as { slug: string; conditions: Record<string, unknown> }[];
      expect(songs).toHaveLength(3);
      for (const song of songs) {
        for (const cond of MIC_CONDITIONS) {
          expect(song.conditions[cond.id]).toBeDefined();
        }
      }
      const suno = out.suno05 as { conditions: Record<string, { fixtures: { q3: unknown[] } }> };
      for (const cond of MIC_CONDITIONS) {
        expect(suno.conditions[cond.id].fixtures.q3).toHaveLength(4);
      }
    },
    1_800_000,
  );
});

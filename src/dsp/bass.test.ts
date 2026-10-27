import { describe, expect, it } from "vitest";
import {
  accumulateLowBandChroma,
  aggregateBassDistribution,
  createLowBandBinMap,
} from "./bass";
import { computeChromagram } from "./chroma";

describe("accumulateLowBandChroma（ピーク補間）", () => {
  it("E2 相当のピークを隣の半音 F ではなく E と読む", () => {
    const sr = 44100;
    const fftSize = 4096;
    const map = createLowBandBinMap(sr, fftSize);
    const mags = new Float32Array(fftSize / 2);
    // E2 = 82.4Hz。ビン幅は約10.8Hzで最寄りビンは 86.1Hz（F 寄り）になるが、
    // 放物線補間で本来のピーク位置に戻せることを確認する。
    mags[7] = 6; // 75.4Hz
    mags[8] = 10; // 86.1Hz（ピークビン）
    mags[9] = 2; // 96.9Hz
    mags[100] = 999; // 帯域外（約1077Hz）は無視されること
    const out = new Float32Array(12);
    accumulateLowBandChroma(mags, map, out);
    const total = out.reduce((s, x) => s + x, 0);
    expect(total).toBeCloseTo(18, 5);
    expect(out[4]).toBeCloseTo(18, 5); // E = pc 4 に全量が寄る
  });

  it("無音スペクトルでは何も加算しない", () => {
    const map = createLowBandBinMap(44100, 4096);
    const out = new Float32Array(12);
    accumulateLowBandChroma(new Float32Array(2048), map, out);
    expect(out.reduce((s, x) => s + x, 0)).toBe(0);
  });
});

describe("computeChromagram の低域フレーム", () => {
  it("C2 の正弦波からは C の低域分布が得られる", () => {
    const sr = 22050;
    const seconds = 2;
    const samples = new Float32Array(sr * seconds);
    for (let i = 0; i < samples.length; i++) {
      samples[i] = 0.8 * Math.sin((2 * Math.PI * 65.41 * i) / sr);
    }
    const chroma = computeChromagram(samples, sr);
    const agg = aggregateBassDistribution(
      chroma.bassFrames,
      0,
      chroma.bassFrames.length,
    );
    expect(agg.topPc).toBe(0); // C
    expect(agg.topShare).toBeGreaterThan(0.8);
  });
});

describe("aggregateBassDistribution", () => {
  it("エネルギー加重で集計し、シェアとマージンを計算する", () => {
    const f1 = new Float32Array(12);
    f1[9] = 10; // A
    const f2 = new Float32Array(12);
    f2[9] = 6;
    f2[0] = 4; // C
    const agg = aggregateBassDistribution([f1, f2], 0, 2);
    expect(agg.topPc).toBe(9);
    expect(agg.topShare).toBeCloseTo(0.8, 5);
    expect(agg.margin).toBeCloseTo(0.6, 5);
    expect(agg.total).toBeCloseTo(20, 5);
  });

  it("範囲外のフレームは集計しない", () => {
    const f1 = new Float32Array(12);
    f1[9] = 10;
    const f2 = new Float32Array(12);
    f2[0] = 10;
    const agg = aggregateBassDistribution([f1, f2], 0, 1);
    expect(agg.topPc).toBe(9);
    expect(agg.total).toBeCloseTo(10, 5);
  });
});

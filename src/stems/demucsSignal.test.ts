import { describe, expect, it } from "vitest";
import {
  combineModelOutputs,
  fftReal,
  istft,
  periodicHannWindow,
  prepareModelInput,
  reflectPad,
  stft,
} from "./demucsSignal";
import { MODEL_SEGMENT_SAMPLES, MODEL_SPEC_BINS, MODEL_SPEC_FRAMES } from "./config";

describe("periodicHannWindow", () => {
  it("周期 Hann の値を返す", () => {
    const w = periodicHannWindow(4);
    expect(w[0]).toBeCloseTo(0);
    expect(w[1]).toBeCloseTo(0.5);
    expect(w[2]).toBeCloseTo(1);
    expect(w[3]).toBeCloseTo(0.5);
  });
});

describe("fftReal", () => {
  it("コサイン波は対応ビンにだけピークが出る", () => {
    const n = 16;
    const input = new Float32Array(n);
    for (let i = 0; i < n; i++) input[i] = Math.cos((2 * Math.PI * 3 * i) / n);
    const { real, imag } = fftReal(input, n);
    expect(real[3]).toBeCloseTo(n / 2, 5);
    expect(imag[3]).toBeCloseTo(0, 5);
    expect(Math.abs(real[5])).toBeLessThan(1e-5);
  });
});

describe("reflectPad", () => {
  it("端を反射して埋める（端の繰り返しなし）", () => {
    const out = reflectPad(new Float32Array([1, 2, 3, 4]), 2, 2);
    expect(Array.from(out)).toEqual([3, 2, 1, 2, 3, 4, 3, 2]);
  });

  it("パディング 0 ではコピーになる", () => {
    const out = reflectPad(new Float32Array([7, 8]), 0, 0);
    expect(Array.from(out)).toEqual([7, 8]);
  });
});

describe("stft / istft", () => {
  it("往復で内側区間が元信号に一致する", () => {
    const length = 32768;
    const signal = new Float32Array(length);
    // 決定的な疑似ランダム信号
    let seed = 42;
    for (let i = 0; i < length; i++) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      signal[i] = seed / 2147483648 - 0.5;
    }
    const spec = stft(signal, 4096, 1024);
    const restored = istft(spec, 4096, 1024);
    expect(restored.length).toBe(length);
    let maxErr = 0;
    for (let i = 8192; i < 24576; i++) {
      maxErr = Math.max(maxErr, Math.abs(restored[i] - signal[i]));
    }
    expect(maxErr).toBeLessThan(1e-3);
  });
});

describe("prepareModelInput", () => {
  it("波形とスペクトログラムの形状がモデル仕様通り", () => {
    const input = prepareModelInput(new Float32Array(1000), new Float32Array(1000));
    expect(input.waveform).toHaveLength(2 * MODEL_SEGMENT_SAMPLES);
    expect(input.magSpec).toHaveLength(4 * MODEL_SPEC_BINS * MODEL_SPEC_FRAMES);
  });

  it("無音入力ではスペクトログラムも全て 0", () => {
    const input = prepareModelInput(new Float32Array(100), new Float32Array(100));
    expect(input.magSpec.every((v) => v === 0)).toBe(true);
  });

  it("波形側はゼロ埋めして L → R の順に並ぶ", () => {
    const left = new Float32Array([0.25, 0.5]);
    const right = new Float32Array([-0.25, -0.5]);
    const input = prepareModelInput(left, right);
    expect(input.waveform[0]).toBe(0.25);
    expect(input.waveform[1]).toBe(0.5);
    expect(input.waveform[2]).toBe(0);
    expect(input.waveform[MODEL_SEGMENT_SAMPLES]).toBe(-0.25);
  });
});

describe("combineModelOutputs", () => {
  it("時間領域だけの出力をトラック別波形へ直す", () => {
    const samples = 8;
    const data = new Float32Array(4 * 2 * samples);
    for (let t = 0; t < 4; t++) {
      for (let c = 0; c < 2; c++) {
        for (let i = 0; i < samples; i++) {
          data[t * 2 * samples + c * samples + i] = t * 100 + c * 10 + i;
        }
      }
    }
    const tracks = combineModelOutputs(data, [1, 4, 2, samples], null);
    expect(tracks).toHaveLength(4);
    expect(tracks[2].left[3]).toBe(203);
    expect(tracks[2].right[3]).toBe(213);
    expect(tracks[0].left[0]).toBe(0);
  });

  it("想定外の形状は例外", () => {
    expect(() =>
      combineModelOutputs(new Float32Array(8), [1, 4, 3, 8], null),
    ).toThrow();
  });
});

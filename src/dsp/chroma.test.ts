import { describe, expect, it } from "vitest";
import { chordBandWeight, computeChromagram } from "./chroma";
import { fftMagnitudes } from "./fft";
import { estimateChordFrames, matchChord } from "../analysis/chordEstimation";
import { framesToSegments } from "../analysis/segmentation";

/** 指定周波数の正弦波和音を合成する */
function synthChord(freqs: number[], seconds: number, sampleRate: number) {
  const n = Math.floor(seconds * sampleRate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (const f of freqs) v += Math.sin((2 * Math.PI * f * i) / sampleRate);
    out[i] = (v / freqs.length) * 0.8;
  }
  return out;
}

describe("fftMagnitudes", () => {
  it("440Hz の正弦波では 440Hz 付近のビンが最大になる", () => {
    const sr = 8192;
    const size = 4096;
    const input = new Float32Array(size);
    for (let i = 0; i < size; i++) {
      input[i] = Math.sin((2 * Math.PI * 440 * i) / sr);
    }
    const mags = fftMagnitudes(input);
    let maxBin = 0;
    for (let b = 1; b < mags.length; b++) if (mags[b] > mags[maxBin]) maxBin = b;
    const peakFreq = (maxBin * sr) / size;
    expect(Math.abs(peakFreq - 440)).toBeLessThanOrEqual(2);
  });
});

describe("chordBandWeight（上帯域クロマの帯域重み）", () => {
  it("境界未満は belowWeight、境界以上は 1 を返す", () => {
    const band = { cutoffHz: 260, belowWeight: 0.25 };
    expect(chordBandWeight(100, band)).toBe(0.25);
    expect(chordBandWeight(259.9, band)).toBe(0.25);
    expect(chordBandWeight(260, band)).toBe(1);
    expect(chordBandWeight(1000, band)).toBe(1);
  });

  it("belowWeight 0 はハードカットになる", () => {
    const band = { cutoffHz: 220, belowWeight: 0 };
    expect(chordBandWeight(82.4, band)).toBe(0);
    expect(chordBandWeight(440, band)).toBe(1);
  });
});

describe("computeChromagram の chordFrames（帯域つきクロマ）", () => {
  const E = 4; // ピッチクラス: C=0, C#=1, D=2, D#=3, E=4

  it("帯域オプション未指定では chordFrames は frames と同一", () => {
    const sr = 22050;
    const samples = synthChord([261.63, 329.63, 392.0], 1, sr);
    const result = computeChromagram(samples, sr);
    expect(result.chordFrames).toBe(result.frames);
  });

  it("低音だけの信号では、ハードカットで E のシェアが大幅に下がる", () => {
    const sr = 22050;
    const samples = synthChord([82.41], 1, sr); // E2 のみ
    const result = computeChromagram(samples, sr, undefined, {
      chordBand: { cutoffHz: 260, belowWeight: 0 },
    });
    const mid = Math.floor(result.frames.length / 2);
    // 全帯域クロマでは E が最大要素になる（窓のリーケージで F 等にも漏れる）
    const full = result.frames[mid];
    expect(full[E]).toBe(Math.max(...full));
    expect(full[E]).toBeGreaterThan(0.4);
    // 帯域つきクロマでは基本波が除かれ、E のシェアは半分以下に落ちる
    // （窓リーケージぶんは帯域上にも残るため 0 にはならない）
    expect(result.chordFrames[mid][E]).toBeLessThan(full[E] * 0.5);
  });

  it("強い低音（E2）に引っ張られず、三和音（C4+E4+G4）を C と判定できる", () => {
    const sr = 22050;
    const chord = synthChord([261.63, 329.63, 392.0], 3, sr);
    const n = chord.length;
    const mixed = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      mixed[i] = chord[i] * 0.6 + Math.sin((2 * Math.PI * 82.41 * i) / sr) * 1.2;
    }
    const result = computeChromagram(mixed, sr, undefined, {
      chordBand: { cutoffHz: 260, belowWeight: 0 },
    });
    const mid = Math.floor(result.frames.length / 2);
    // 全帯域では低音由来の E が最大要素になる（分数コード崩壊の素地）
    const full = result.frames[mid];
    expect(full[E]).toBe(Math.max(...full));
    // 上帯域では E（コード構成音としての E4 ぶんを除く）が下がり、
    // C と G の合計が E を上回って C メジャーに戻る
    const band = result.chordFrames[mid];
    expect(band[E]).toBeLessThan(full[E]);
    expect(band[0] + band[7]).toBeGreaterThan(band[E]);
    expect(matchChord(band).chord).toBe("C");
  });
});

describe("パイプライン（合成音声 → セグメント）", () => {
  it("C メジャーの和音（C4+E4+G4）を持続させると C のセグメントが得られる", () => {
    const sr = 22050;
    const samples = synthChord([261.63, 329.63, 392.0], 3, sr);
    const chroma = computeChromagram(samples, sr);
    const frames = estimateChordFrames(
      chroma.frames,
      chroma.energies,
      chroma.frameDuration,
    );
    const segments = framesToSegments(frames, chroma.frameDuration, 3);
    expect(segments.length).toBeGreaterThan(0);
    // 最も長いセグメントが C であること
    const longest = [...segments].sort(
      (a, b) => b.end - b.start - (a.end - a.start),
    )[0];
    expect(longest.chord).toBe("C");
  });
});

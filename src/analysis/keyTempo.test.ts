import { describe, expect, it } from "vitest";
import { estimateKey, estimateTempo } from "./keyTempo";

describe("estimateKey", () => {
  it("C メジャー寄りのクロマからは C major が得られる", () => {
    // C メジャースケールの音を中心にした合成クロマフレーム
    const frame = new Float32Array(12);
    for (const pc of [0, 2, 4, 5, 7, 9, 11]) frame[pc] = 1;
    frame[0] = 2; // 主音を強調
    frame[7] = 1.5;
    const frames = Array.from({ length: 10 }, () => Float32Array.from(frame));
    const key = estimateKey(frames);
    expect(key.root).toBe(0);
    expect(key.mode).toBe("major");
  });
});

describe("estimateTempo", () => {
  it("120 BPM 相当の周期パルスからは 120 前後が得られる", () => {
    const frameDuration = 2048 / 44100; // 解析時と同じホップ想定
    // 120 BPM = 0.5 秒周期
    const periodFrames = Math.round(0.5 / frameDuration);
    const total = periodFrames * 40;
    const env = new Float32Array(total);
    for (let i = 0; i < total; i += periodFrames) env[i] = 1;
    const bpm = estimateTempo(env, frameDuration);
    expect(bpm).not.toBeNull();
    expect(Math.abs((bpm ?? 0) - 120)).toBeLessThanOrEqual(6);
  });

  it("無音（全ゼロ）では null を返す", () => {
    expect(estimateTempo(new Float32Array(100), 0.05)).toBeNull();
  });
});

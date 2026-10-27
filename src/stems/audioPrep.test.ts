import { describe, expect, it } from "vitest";
import {
  downmixToMono,
  extractStereoChannels,
  resampleChannel,
  resampleStereo,
  type AudioBufferLike,
} from "./audioPrep";

function fakeBuffer(channels: Float32Array[], sampleRate: number): AudioBufferLike {
  return {
    numberOfChannels: channels.length,
    sampleRate,
    length: channels[0].length,
    getChannelData: (ch) => channels[ch],
  };
}

describe("extractStereoChannels", () => {
  it("ステレオはそのまま取り出す", () => {
    const left = new Float32Array([1, 2, 3]);
    const right = new Float32Array([4, 5, 6]);
    const out = extractStereoChannels(fakeBuffer([left, right], 48000));
    expect(Array.from(out.left)).toEqual([1, 2, 3]);
    expect(Array.from(out.right)).toEqual([4, 5, 6]);
    expect(out.sampleRate).toBe(48000);
  });

  it("モノラルは両チャンネルへ複製する", () => {
    const mono = new Float32Array([0.5, -0.5]);
    const out = extractStereoChannels(fakeBuffer([mono], 44100));
    expect(Array.from(out.left)).toEqual([0.5, -0.5]);
    expect(Array.from(out.right)).toEqual([0.5, -0.5]);
  });
});

describe("resampleChannel", () => {
  it("同一レートでは値が変わらない", () => {
    const src = new Float32Array([0, 0.5, -0.5, 1]);
    const out = resampleChannel(src, 44100, 44100);
    expect(Array.from(out)).toEqual(Array.from(src));
  });

  it("ダウンサンプルは等間隔に拾う", () => {
    const out = resampleChannel(new Float32Array([0, 1, 2, 3]), 4, 2);
    expect(Array.from(out)).toEqual([0, 2]);
  });

  it("アップサンプルは線形補間する", () => {
    const out = resampleChannel(new Float32Array([0, 2]), 1, 2);
    expect(Array.from(out)).toEqual([0, 1, 2, 2]);
  });

  it("空入力は空出力", () => {
    expect(resampleChannel(new Float32Array(0), 48000, 44100)).toHaveLength(0);
  });
});

describe("resampleStereo / downmixToMono", () => {
  it("resampleStereo は両 ch を変換しレートを更新する", () => {
    const out = resampleStereo(
      { left: new Float32Array([0, 1, 2, 3]), right: new Float32Array([3, 2, 1, 0]), sampleRate: 4 },
      2,
    );
    expect(out.sampleRate).toBe(2);
    expect(Array.from(out.left)).toEqual([0, 2]);
    expect(Array.from(out.right)).toEqual([3, 1]);
  });

  it("downmixToMono は平均を取る", () => {
    const out = downmixToMono({
      left: new Float32Array([1, -1, 0.5]),
      right: new Float32Array([0, 1, 0.5]),
    });
    expect(Array.from(out)).toEqual([0.5, 0, 0.5]);
  });
});

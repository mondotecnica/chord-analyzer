import type { StereoAudio } from "./types";

/**
 * 分離前段の音声整形（純粋関数）。
 * - AudioBuffer からステレオを取り出す（モノラルは両 ch に複製）
 * - Demucs の要求する 44.1kHz へ線形補間でリサンプルする
 * - ステム（ステレオ）を解析用のモノラルへ戻す
 */

/** AudioBuffer の最小限の形（テストで差し替え可能にする） */
export interface AudioBufferLike {
  numberOfChannels: number;
  sampleRate: number;
  length: number;
  getChannelData(channel: number): Float32Array;
}

export function extractStereoChannels(buffer: AudioBufferLike): StereoAudio {
  const left = buffer.getChannelData(0);
  if (buffer.numberOfChannels < 2) {
    return {
      left: new Float32Array(left),
      right: new Float32Array(left),
      sampleRate: buffer.sampleRate,
    };
  }
  return {
    left: new Float32Array(left),
    right: new Float32Array(buffer.getChannelData(1)),
    sampleRate: buffer.sampleRate,
  };
}

/** 線形補間リサンプル（単一チャンネル）。同一レートならコピーを返す */
export function resampleChannel(
  samples: Float32Array,
  fromRate: number,
  toRate: number,
): Float32Array {
  if (fromRate === toRate) return new Float32Array(samples);
  if (samples.length === 0) return new Float32Array(0);
  const outLength = Math.max(
    1,
    Math.round((samples.length * toRate) / fromRate),
  );
  const out = new Float32Array(outLength);
  const ratio = fromRate / toRate;
  for (let i = 0; i < outLength; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const a = samples[Math.min(idx, samples.length - 1)];
    const b = samples[Math.min(idx + 1, samples.length - 1)];
    out[i] = a + (b - a) * frac;
  }
  return out;
}

export function resampleStereo(
  audio: StereoAudio,
  toRate: number,
): StereoAudio {
  if (audio.sampleRate === toRate) return audio;
  return {
    left: resampleChannel(audio.left, audio.sampleRate, toRate),
    right: resampleChannel(audio.right, audio.sampleRate, toRate),
    sampleRate: toRate,
  };
}

/** ステレオ → モノラル（平均）。解析パイプラインの入力形式に合わせる */
export function downmixToMono(audio: {
  left: Float32Array;
  right: Float32Array;
}): Float32Array {
  const { left, right } = audio;
  const out = new Float32Array(left.length);
  for (let i = 0; i < left.length; i++) {
    out[i] = (left[i] + (right[i] ?? 0)) / 2;
  }
  return out;
}

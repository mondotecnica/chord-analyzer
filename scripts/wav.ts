/**
 * 最小限の WAV (16-bit PCM) 読み書き。
 * 合成テスト音源の生成と、Node 上での解析ハーネス専用。
 * 自分で生成したファイルの読み戻しだけを想定している（読み込みはモノラル化する）。
 */
import { readFileSync, writeFileSync } from "node:fs";

export function writeWav16(path: string, samples: Float32Array, sampleRate: number): void {
  const dataSize = samples.length * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16); // fmt chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  writeFileSync(path, buf);
}

export interface WavData {
  samples: Float32Array;
  sampleRate: number;
}

export function readWav16(path: string): WavData {
  const buf = readFileSync(path);
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error(`WAV ではありません: ${path}`);
  }
  let offset = 12;
  let sampleRate = 0;
  let channels = 1;
  let bitsPerSample = 0;
  let dataStart = -1;
  let dataSize = 0;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === "fmt ") {
      const format = buf.readUInt16LE(offset + 8);
      if (format !== 1) throw new Error(`PCM 形式のみ対応 (format=${format})`);
      channels = buf.readUInt16LE(offset + 10);
      sampleRate = buf.readUInt32LE(offset + 12);
      bitsPerSample = buf.readUInt16LE(offset + 22);
    } else if (id === "data") {
      dataStart = offset + 8;
      dataSize = size;
      break;
    }
    offset += 8 + size + (size % 2);
  }
  if (dataStart < 0 || sampleRate === 0 || bitsPerSample !== 16) {
    throw new Error(`対応できない WAV です: ${path}`);
  }
  const frameCount = Math.floor(dataSize / 2 / channels);
  const samples = new Float32Array(frameCount);
  for (let i = 0; i < frameCount; i++) {
    // モノラル化（チャンネル平均）
    let sum = 0;
    for (let ch = 0; ch < channels; ch++) {
      sum += buf.readInt16LE(dataStart + (i * channels + ch) * 2);
    }
    samples[i] = sum / channels / 32768;
  }
  return { samples, sampleRate };
}

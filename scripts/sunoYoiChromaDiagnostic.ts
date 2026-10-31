/**
 * 診断（一回限り）: 宵のひかり素材のクロマ回転チェック。
 * 各ファイルの平均クロマベクトルと、05.mp3 を基準とした最適回転
 * （半音単位のコサイン類似度最大）を出し、音程のずれが
 * 「ファイル側」か「解析側（SR 依存）」かを切り分ける。
 * 実行: npx vitest run scripts/suno-yoi-diagnostic.test.ts
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { computeChromagram } from "../src/dsp/chroma";
import { estimateKey } from "../src/analysis/keyTempo";
import { loadAudioFile } from "./measureReal";
import { readWav16 } from "./wav";

const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));
const WORK = join(PROJECT_ROOT, "stem-work/suno-yoi");

function meanChroma(samples: Float32Array, sr: number): Float64Array {
  const cg = computeChromagram(samples, sr);
  const out = new Float64Array(12);
  let w = 0;
  cg.frames.forEach((f, i) => {
    const e = cg.energies[i] ?? 0;
    for (let pc = 0; pc < 12; pc++) out[pc] += f[pc] * e;
    w += e;
  });
  for (let pc = 0; pc < 12; pc++) out[pc] /= Math.max(w, 1e-12);
  return out;
}

function cosine(a: Float64Array, b: Float64Array, rot: number): number {
  let dot = 0, na = 0, nb = 0;
  for (let pc = 0; pc < 12; pc++) {
    const bv = b[(pc + rot) % 12];
    dot += a[pc] * bv;
    na += a[pc] * a[pc];
    nb += bv * bv;
  }
  return dot / Math.sqrt(Math.max(na * nb, 1e-18));
}

export function runDiagnostic() {
  const files: Record<string, { samples: Float32Array; sampleRate: number }> = {
    "05.mp3 (44.1k, ffmpeg decode)": loadAudioFile(
      join(PROJECT_ROOT, "..", "user", "files", "05.mp3"),
    ),
    "mix.wav (48k, python sum)": readWav16(join(WORK, "mix.wav")),
    "mix44.wav (44.1k, ffmpeg resample of mix.wav)": readWav16(join(WORK, "mix44.wav")),
    "other_suno.wav (48k, python sum)": readWav16(join(WORK, "other_suno.wav")),
    "src/bass.wav (48k, ffmpeg decode of MP3)": readWav16(join(WORK, "src/bass.wav")),
    "demucs other.wav (44.1k)": readWav16(join(WORK, "htdemucs/mix/other.wav")),
  };
  // 05.mp3 のパス解決（loadAudioFile は絶対パス前提）
  const chromas: Record<string, Float64Array> = {};
  const keys: Record<string, string> = {};
  for (const [name, f] of Object.entries(files)) {
    chromas[name] = meanChroma(f.samples, f.sampleRate);
    const cg = computeChromagram(f.samples, f.sampleRate);
    const k = estimateKey(cg.frames);
    keys[name] = `${k.keyName} corr=${k.correlation.toFixed(3)}`;
  }
  const base = chromas["05.mp3 (44.1k, ffmpeg decode)"];
  const rotations: Record<string, { bestRot: number; bestCos: number; cos0: number }> = {};
  for (const [name, c] of Object.entries(chromas)) {
    let bestRot = 0, bestCos = -1;
    for (let r = 0; r < 12; r++) {
      const cs = cosine(base, c, r);
      if (cs > bestCos) { bestCos = cs; bestRot = r; }
    }
    rotations[name] = { bestRot, bestCos, cos0: cosine(base, c, 0) };
  }
  // 同一サンプル（mix.wav）を SR だけ変えてキー推定（解析側 SR 依存の切り分け）
  const mix = readWav16(join(WORK, "mix.wav"));
  const keyAt = (sr: number) => {
    const cg = computeChromagram(mix.samples, sr);
    const k = estimateKey(cg.frames);
    return `${k.keyName}@${sr}`;
  };
  return {
    keys,
    rotationsVs05: rotations,
    mixWavKeyByAssumedSr: [44100, 48000].map(keyAt),
    chromaVectors: Object.fromEntries(
      Object.entries(chromas).map(([k, v]) => [k, [...v].map((x) => Math.round(x * 1000) / 1000)]),
    ),
  };
}

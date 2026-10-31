/**
 * 診断2（一回限り）: 48kHz でのクロマ回転の切り分け。
 * (1) 合成 Am 三和音（純正弦波の和）を 44.1k / 48k で生成し、
 *     プロジェクトのクロマ＋キー推定が両 SR で正しいかを見る
 *     → 回れば実装の SR 依存欠陥、回らなければ素材との相互作用。
 * (2) 実素材コントロール: mix44（44.1k）の混合音解析と、
 *     05.mp3 を 48k に正しくリサンプルした版の混合音解析のキー。
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeAudio } from "../src/analysis/analyze";
import { estimateKey } from "../src/analysis/keyTempo";
import { computeChromagram } from "../src/dsp/chroma";
import { readWav16 } from "./wav";

const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));
const WORK = join(PROJECT_ROOT, "stem-work/suno-yoi");

function synthChord(freqs: number[], sr: number, sec = 6): Float32Array {
  const n = Math.floor(sr * sec);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (const f of freqs) {
      // 基本波＋弱い倍音（楽器らしい最低限の成分）
      v += Math.sin(2 * Math.PI * f * (i / sr));
      v += 0.4 * Math.sin(2 * Math.PI * f * 2 * (i / sr));
      v += 0.2 * Math.sin(2 * Math.PI * f * 3 * (i / sr));
    }
    const env = Math.min(1, i / (sr * 0.05), (n - i) / (sr * 0.05));
    out[i] = (v / freqs.length) * 0.5 * env;
  }
  return out;
}

function topRoots(result: Awaited<ReturnType<typeof analyzeAudio>>, n = 5) {
  const tally = new Map<string, number>();
  for (const s of result.segments) {
    tally.set(s.chord, (tally.get(s.chord) ?? 0) + (s.end - s.start));
  }
  return [...tally.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, v]) => `${k}:${Math.round(v)}s`);
}

export async function runDiagnostic2() {
  const out: Record<string, unknown> = {};
  // (1) 合成 Am（A2 110 / C3 130.81 / E3 164.81 / A3 220）と C（C3/E3/G3/C4）
  for (const sr of [44100, 48000]) {
    for (const [name, freqs] of [
      ["Am", [110, 130.81, 164.81, 220]],
      ["C", [130.81, 164.81, 196, 261.63]],
    ] as const) {
      const samples = synthChord([...freqs], sr);
      const cg = computeChromagram(samples, sr);
      const key = estimateKey(cg.frames);
      const prof = new Array(12).fill(0);
      for (const f of cg.frames) for (let p = 0; p < 12; p++) prof[p] += f[p];
      const top = prof
        .map((v, p) => [p, v] as const)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([p]) => p);
      out[`synth ${name} @${sr}`] = { key: key.keyName, topPcs: top };
    }
  }
  // (2a) mix44 を混合音経路で
  const mix44 = readWav16(join(WORK, "mix44.wav"));
  const resMix44 = await analyzeAudio(mix44.samples, mix44.sampleRate, "mix44.wav");
  out["analyzeAudio mix44 (44.1k)"] = {
    key: resMix44.keyName,
    bpm: resMix44.bpm,
    topRoots: topRoots(resMix44),
  };
  // (2b) 05 を 48k に正しくリサンプルした版（/tmp/05-48k.wav、ffmpeg で事前作成）
  try {
    const s48 = readWav16("/tmp/05-48k.wav");
    const res48 = await analyzeAudio(s48.samples, s48.sampleRate, "05-48k.wav");
    out["analyzeAudio 05@48k (true resample)"] = {
      key: res48.keyName,
      bpm: res48.bpm,
      topRoots: topRoots(res48),
    };
  } catch (e) {
    out["analyzeAudio 05@48k (true resample)"] = `skipped: ${e}`;
  }
  return out;
}

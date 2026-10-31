/**
 * マイク入力シミュレーション測定ハーネス。
 *
 * 「スピーカーで鳴らしてマイクで拾う」「生音をマイクで録る」という入力経路を
 * 製品に入れる価値があるか判断するため、クリーンなファイル入力に対して
 * ソフト側で劣化チェーンを再現し、精度の落ち幅を実曲で測る。
 * ハードウェア実測の代替ではない（留保は measurements/mic-input/MIC_INPUT_SIM.md）。
 *
 * 劣化はすべて決定的処理（シード固定 PRNG）で、パラメータは結果 JSON に記録する。
 * 処理順（条件ごと）:
 *   clean    : 無加工（ベースライン。既存ハーネスの mixture 測定とビット一致する入力）
 *   live     : 残響（小部屋）→ 室内ノイズ加算 → ピーク正規化
 *   spk-good : スピーカー帯域制限 → 残響 → ノイズ → ピーク正規化
 *   spk-bad  : 強い帯域制限 → 長い残響 → 多めのノイズ → 軽い圧縮 → ピーク正規化
 *
 * 解析は製品の簡易モード相当（混合音・既定オプション {}）で統一する。
 * 実行は scripts/measure-mic-input.test.ts 経由（vitest）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeAudio } from "../src/analysis/analyze";
import { displaySegmentChord } from "../src/lib/chordDisplay";
import { NO_CHORD } from "../src/lib/notes";
import type { AnalysisResult, ChordSegment } from "../src/types";
import {
  loadAudioFile,
  measureRealSong,
  parseTruthJson,
  type RealTruth,
} from "./measureReal";
import { parseChord } from "./measureSynthetic";
import { dominantFullLabel, dominantSegment } from "./measurePhase3";
import { STEM_SONGS } from "./measureStems";

const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));
export const MIC_OUT_DIR = join(PROJECT_ROOT, "measurements", "mic-input");
const RESULTS_PATH = join(MIC_OUT_DIR, "mic-input-results.json");
const MIX05_PATH = join(homedir(), "workspace/user/files/05.mp3");

// ---------------------------------------------------------------------------
// 決定的 PRNG（mulberry32）
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// DSP 部品
// ---------------------------------------------------------------------------

/** 反復型 radix-2 FFT（in-place、2 の冪長専用） */
function fft(re: Float64Array, im: Float64Array, invert: boolean): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((invert ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cwr = 1;
      let cwi = 0;
      for (let j = 0; j < len / 2; j++) {
        const ur = re[i + j];
        const ui = im[i + j];
        const vr = re[i + j + len / 2] * cwr - im[i + j + len / 2] * cwi;
        const vi = re[i + j + len / 2] * cwi + im[i + j + len / 2] * cwr;
        re[i + j] = ur + vr;
        im[i + j] = ui + vi;
        re[i + j + len / 2] = ur - vr;
        im[i + j + len / 2] = ui - vi;
        const nwr = cwr * wr - cwi * wi;
        cwi = cwr * wi + cwi * wr;
        cwr = nwr;
      }
    }
  }
  if (invert) {
    for (let i = 0; i < n; i++) {
      re[i] /= n;
      im[i] /= n;
    }
  }
}

/** オーバーラップ加算による線形畳み込み（FFT） */
function convolve(x: Float32Array, ir: Float32Array): Float32Array {
  const out = new Float32Array(x.length + ir.length - 1);
  const block = 65536;
  let fftSize = 1;
  while (fftSize < block + ir.length - 1) fftSize <<= 1;
  const irRe = new Float64Array(fftSize);
  const irIm = new Float64Array(fftSize);
  irRe.set(ir);
  fft(irRe, irIm, false);
  const re = new Float64Array(fftSize);
  const im = new Float64Array(fftSize);
  for (let start = 0; start < x.length; start += block) {
    const len = Math.min(block, x.length - start);
    re.fill(0);
    im.fill(0);
    for (let i = 0; i < len; i++) re[i] = x[start + i];
    fft(re, im, false);
    for (let i = 0; i < fftSize; i++) {
      const pr = re[i] * irRe[i] - im[i] * irIm[i];
      const pi = re[i] * irIm[i] + im[i] * irRe[i];
      re[i] = pr;
      im[i] = pi;
    }
    fft(re, im, true);
    const outLen = len + ir.length - 1;
    for (let i = 0; i < outLen; i++) out[start + i] += re[i];
  }
  return out;
}

interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

function lowpass(freq: number, q: number, sr: number): Biquad {
  const w = (2 * Math.PI * freq) / sr;
  const alpha = Math.sin(w) / (2 * q);
  const cos = Math.cos(w);
  const a0 = 1 + alpha;
  return {
    b0: (1 - cos) / 2 / a0,
    b1: (1 - cos) / a0,
    b2: (1 - cos) / 2 / a0,
    a1: (-2 * cos) / a0,
    a2: (1 - alpha) / a0,
  };
}

function highpass(freq: number, q: number, sr: number): Biquad {
  const w = (2 * Math.PI * freq) / sr;
  const alpha = Math.sin(w) / (2 * q);
  const cos = Math.cos(w);
  const a0 = 1 + alpha;
  return {
    b0: (1 + cos) / 2 / a0,
    b1: (-(1 + cos)) / a0,
    b2: (1 + cos) / 2 / a0,
    a1: (-2 * cos) / a0,
    a2: (1 - alpha) / a0,
  };
}

function applyBiquad(x: Float32Array, c: Biquad): Float32Array {
  const out = new Float32Array(x.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const x0 = x[i];
    const y0 = c.b0 * x0 + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    out[i] = y0;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
  }
  return out;
}

/**
 * 合成インパルス応答: 周波数領域で合成する（ランダム位相＋平坦な振幅特性）。
 * 時間領域でホワイトノイズに包絡を掛ける方式は、帯域ごとのゲインがランダムに
 * 暴走し（低域寄り信号で wet が +17dB 級に膨らんだ実測あり）、wetDb が
 * 意図した直接音／残響音比にならないため採らない。周波数合成なら振幅特性が
 * 制御でき、wet の広帯域 RMS 比が入力の帯域分布によらず wetDb どおりになる。
 * 振幅整形は帯域端のみ（30Hz 以下と 18kHz 以上を落とす）。
 * 時間波形に指数減衰包絡（RT60 で -60dB）を掛け、エネルギーを 1 に正規化する。
 * 高域ほど残響が短い実室内の性質は再現しない代わりに、全帯域で
 * パワーゲイン ≈ 1 が保たれ、wet 比が入力の帯域分布によらず wetDb どおりになる
 * （診断で検証）。暗色化フィルタを入れると再正規化で低域ゲインが膨らみ、
 * wet 比が制御不能になるため入れない。
 * 長さは RT60 の 3 倍（上限 2.5 秒）。
 */
function makeRoomIR(sr: number, rt60: number, seed: number): Float32Array {
  const len = Math.min(Math.floor(sr * rt60 * 3), Math.floor(sr * 2.5));
  let fftSize = 1;
  while (fftSize < len) fftSize <<= 1;
  const rand = mulberry32(seed);
  const re = new Float64Array(fftSize);
  const im = new Float64Array(fftSize);
  for (let k = 1; k < fftSize / 2; k++) {
    const f = (k * sr) / fftSize;
    let amp = 1;
    if (f < 30) amp = f / 30;
    else if (f > 18000) amp = Math.max(0, (20000 - f) / 2000);
    const phase = rand() * 2 * Math.PI;
    re[k] = amp * Math.cos(phase);
    im[k] = amp * Math.sin(phase);
    re[fftSize - k] = amp * Math.cos(phase);
    im[fftSize - k] = -amp * Math.sin(phase);
  }
  fft(re, im, true);
  const ir = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const t = i / sr;
    const env = Math.pow(10, (-3 * t) / rt60);
    ir[i] = re[i] * env;
  }
  let energy = 0;
  for (let i = 0; i < len; i++) energy += ir[i] * ir[i];
  const norm = 1 / Math.sqrt(energy);
  for (let i = 0; i < len; i++) ir[i] *= norm;
  return ir;
}

/** 室内ノイズ想定: ホワイトノイズを 1 ポール LP（400Hz）で低域寄りにしたもの（未スケール） */
function makeRoomNoise(n: number, sr: number, seed: number): Float32Array {
  const rand = mulberry32(seed);
  const out = new Float32Array(n);
  const a = 1 - Math.exp((-2 * Math.PI * 400) / sr);
  let lp = 0;
  for (let i = 0; i < n; i++) {
    const w = rand() * 2 - 1;
    lp += a * (w - lp);
    out[i] = lp;
  }
  return out;
}

function rms(x: Float32Array): number {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, x.length));
}

function peakNormalize(x: Float32Array, target: number): Float32Array {
  let peak = 0;
  for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]));
  if (peak === 0) return x;
  const g = target / peak;
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = x[i] * g;
  return out;
}

/** 軽いフィードフォワード圧縮（電話 AGC の粗い近似）。メイクアップなし */
function compress(
  x: Float32Array,
  sr: number,
  thresholdDb: number,
  ratio: number,
  attackSec: number,
  releaseSec: number,
): Float32Array {
  const out = new Float32Array(x.length);
  const atk = Math.exp(-1 / (sr * attackSec));
  const rel = Math.exp(-1 / (sr * releaseSec));
  let env = 0;
  for (let i = 0; i < x.length; i++) {
    const a = Math.abs(x[i]);
    env = a > env ? atk * env + (1 - atk) * a : rel * env + (1 - rel) * a;
    const envDb = 20 * Math.log10(Math.max(env, 1e-9));
    const over = envDb - thresholdDb;
    const gainDb = over > 0 ? -over * (1 - 1 / ratio) : 0;
    out[i] = x[i] * Math.pow(10, gainDb / 20);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 劣化条件
// ---------------------------------------------------------------------------

export interface MicConditionParams {
  id: string;
  label: string;
  /** スピーカー帯域制限（null = なし） */
  band: { hpHz: number; hpStages: number; lpHz: number; lpStages: number } | null;
  /** 残響（null = なし）。wetDb は単位エネルギー IR 畳み込み出力への振幅ゲイン [dB] */
  reverb: { rt60Sec: number; wetDb: number; irSeed: number } | null;
  /** ノイズ（null = なし）。snrDb は信号全区間 RMS に対する広帯域 SNR */
  noise: { snrDb: number; seed: number } | null;
  /** 圧縮（null = なし） */
  comp: { thresholdDb: number; ratio: number; attackSec: number; releaseSec: number } | null;
  /** 最終ピーク正規化の目標（clean は無加工のため null） */
  peakTarget: number | null;
}

export const MIC_CONDITIONS: MicConditionParams[] = [
  {
    id: "clean",
    label: "clean（原音そのまま）",
    band: null,
    reverb: null,
    noise: null,
    comp: null,
    peakTarget: null,
  },
  {
    id: "live",
    label: "生音マイク想定（残響 RT60 0.4s + ノイズ SNR 25dB）",
    band: null,
    reverb: { rt60Sec: 0.4, wetDb: -10, irSeed: 1001 },
    noise: { snrDb: 25, seed: 2001 },
    comp: null,
    peakTarget: 0.95,
  },
  {
    id: "spk-good",
    label: "スピーカー再生＋マイク・良条件（150Hz–12kHz + RT60 0.4s + SNR 22dB）",
    band: { hpHz: 150, hpStages: 1, lpHz: 12000, lpStages: 1 },
    reverb: { rt60Sec: 0.4, wetDb: -8, irSeed: 1002 },
    noise: { snrDb: 22, seed: 2002 },
    comp: null,
    peakTarget: 0.95,
  },
  {
    id: "spk-bad",
    label: "スピーカー再生＋マイク・悪条件（300Hz–8kHz + RT60 0.8s + SNR 13dB + 圧縮）",
    band: { hpHz: 300, hpStages: 2, lpHz: 8000, lpStages: 2 },
    reverb: { rt60Sec: 0.8, wetDb: -5, irSeed: 1003 },
    noise: { snrDb: 13, seed: 2003 },
    comp: { thresholdDb: -20, ratio: 3, attackSec: 0.01, releaseSec: 0.3 },
    peakTarget: 0.95,
  },
];

/** 診断・検証用に内部部品を公開する（測定本体は degrade 経由でのみ使う） */
export const __internals = {
  mulberry32,
  convolve,
  makeRoomIR,
  makeRoomNoise,
  applyBiquad,
  lowpass,
  highpass,
  rms,
};

export function degrade(
  samples: Float32Array,
  sr: number,
  cond: MicConditionParams,
): Float32Array {
  if (cond.id === "clean") return new Float32Array(samples);
  let y: Float32Array = new Float32Array(samples);
  if (cond.band) {
    for (let i = 0; i < cond.band.hpStages; i++) {
      y = applyBiquad(y, highpass(cond.band.hpHz, Math.SQRT1_2, sr));
    }
    for (let i = 0; i < cond.band.lpStages; i++) {
      y = applyBiquad(y, lowpass(cond.band.lpHz, Math.SQRT1_2, sr));
    }
  }
  if (cond.reverb) {
    const ir = makeRoomIR(sr, cond.reverb.rt60Sec, cond.reverb.irSeed);
    const wet = convolve(y, ir);
    const wetGain = Math.pow(10, cond.reverb.wetDb / 20);
    const out = new Float32Array(y.length);
    for (let i = 0; i < y.length; i++) out[i] = y[i] + wetGain * wet[i];
    y = out;
  }
  if (cond.noise) {
    const noise = makeRoomNoise(y.length, sr, cond.noise.seed);
    const sigRms = rms(y);
    const noiseRms = rms(noise);
    const scale = sigRms / (noiseRms * Math.pow(10, cond.noise.snrDb / 20));
    for (let i = 0; i < y.length; i++) y[i] += noise[i] * scale;
  }
  if (cond.comp) {
    y = compress(y, sr, cond.comp.thresholdDb, cond.comp.ratio, cond.comp.attackSec, cond.comp.releaseSec);
  }
  if (cond.peakTarget !== null) y = peakNormalize(y, cond.peakTarget);
  return y;
}

// ---------------------------------------------------------------------------
// 05 フィクスチャ（measureSunoYoi の判定と同一の決着・同じ時刻）
// ---------------------------------------------------------------------------

const Q3_SLICES: { range: [number, number]; expected: string; accept: string[]; triad: string }[] = [
  { range: [85, 87], expected: "C", accept: ["C", "CM7"], triad: "C:major" },
  { range: [87, 89], expected: "B7", accept: ["B7"], triad: "B:major" },
  { range: [89, 91], expected: "E7", accept: ["E7"], triad: "E:major" },
  { range: [91, 93], expected: "Am", accept: ["Am", "Am7"], triad: "A:minor" },
];

function maxOverlapSegment(
  result: AnalysisResult,
  lo: number,
  hi: number,
): ChordSegment | null {
  let best: ChordSegment | null = null;
  let bestOv = -1;
  for (const s of result.segments) {
    const ov = Math.min(s.end, hi) - Math.max(s.start, lo);
    if (ov > bestOv) {
      bestOv = ov;
      best = s;
    }
  }
  return best;
}

/** 0.05 秒標本で窓内の「root＋mode」一致秒数を数える */
function sampledChordSec(
  result: AnalysisResult,
  lo: number,
  hi: number,
  pred: (root: number, mode: string) => boolean,
): number {
  const step = 0.05;
  let sec = 0;
  let idx = 0;
  const segs = result.segments;
  for (let t = lo; t < hi; t += step) {
    const mid = t + step / 2;
    while (idx < segs.length - 1 && mid >= segs[idx].end) idx++;
    const s = segs[idx];
    if (!s || mid < s.start || mid >= s.end || s.chord === NO_CHORD) continue;
    const p = parseChord(s.chord);
    if (p && pred(p.root, p.mode)) sec += step;
  }
  return sec;
}

function triadDominantInWindow(result: AnalysisResult, lo: number, hi: number): string | null {
  const step = 0.05;
  const tally = new Map<string, number>();
  let idx = 0;
  const segs = result.segments;
  for (let t = lo; t < hi; t += step) {
    const mid = t + step / 2;
    while (idx < segs.length - 1 && mid >= segs[idx].end) idx++;
    const s = segs[idx];
    if (!s || mid < s.start || mid >= s.end || s.chord === NO_CHORD) continue;
    const p = parseChord(s.chord);
    if (!p) continue;
    const key = `${p.root}:${p.mode}`;
    tally.set(key, (tally.get(key) ?? 0) + step);
  }
  let best: string | null = null;
  let bv = -1;
  for (const [k, v] of tally) {
    if (v > bv) {
      bv = v;
      best = k;
    }
  }
  if (!best) return null;
  const [rootStr, mode] = best.split(":");
  const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  return `${NAMES[Number(rootStr)]}:${mode}`;
}

function fixtures05(result: AnalysisResult) {
  const q1Ranges: [number, number][] = [
    [51, 56],
    [93, 98],
  ];
  const q1 = q1Ranges.map((range) => {
    const dom = dominantSegment(result, range[0], range[1]);
    const seg = maxOverlapSegment(result, range[0], range[1]);
    return {
      range,
      dominantChord: dom?.chord ?? null,
      bassPc: dom?.bassPc ?? null,
      /** 決着: ベース D（bassPc=2）が正 */
      bassCorrect: dom?.bassPc === 2,
      /** 決着: 層表示 C/D */
      display: seg ? displaySegmentChord(seg) : null,
      displayCorrect: seg ? displaySegmentChord(seg) === "C/D" : false,
    };
  });
  const q4Dom = dominantSegment(result, 62, 65);
  const q4Seg = maxOverlapSegment(result, 62, 65);
  const q4 = {
    range: [62, 65] as [number, number],
    dominantChord: q4Dom?.chord ?? null,
    bassPc: q4Dom?.bassPc ?? null,
    /** 決着: ベース C#（bassPc=1）が実在 */
    bassCorrect: q4Dom?.bassPc === 1,
    /** 決着: 層表示 CM7/C# */
    display: q4Seg ? displaySegmentChord(q4Seg) : null,
    displayCorrect: q4Seg ? displaySegmentChord(q4Seg) === "CM7/C#" : false,
  };
  const q3 = Q3_SLICES.map((s) => {
    const dom = dominantFullLabel(result, s.range[0], s.range[1]);
    const triDom = triadDominantInWindow(result, s.range[0], s.range[1]);
    return {
      range: s.range,
      expected: s.expected,
      label: dom?.label ?? null,
      /** 完全名（7th 込み）での一致。第2段 OFF の既定では基本的に false が正常 */
      fullPass: dom !== null && s.accept.includes(dom.label),
      triadDominant: triDom,
      /** 三和音レベル（root＋major/minor）の一致 */
      triadPass: triDom === s.triad,
    };
  });
  const q2Sub = ([[153, 158], [158, 163], [163, 168]] as [number, number][]).map(
    ([lo, hi]) => ({
      range: [lo, hi] as [number, number],
      dominant: dominantFullLabel(result, lo, hi)?.label ?? null,
    }),
  );
  const q2 = {
    range: [153, 168] as [number, number],
    /** 窓内で Cm と読まれた秒数（色彩イベント自体は実在。代表ラベル化が問題になる量） */
    cmSec: Math.round(sampledChordSec(result, 153, 168, (r, m) => r === 0 && m === "minor") * 100) / 100,
    /** 窓内で C メジャーと読まれた秒数 */
    cSec: Math.round(sampledChordSec(result, 153, 168, (r, m) => r === 0 && m === "major") * 100) / 100,
    subWindows: q2Sub,
  };
  return { q1, q2, q3, q4 };
}

// ---------------------------------------------------------------------------
// 測定本体
// ---------------------------------------------------------------------------

function meanConfidence(result: AnalysisResult): number {
  const segs = result.segments;
  const total = segs.reduce((a, s) => a + (s.end - s.start), 0);
  if (total <= 0) return 0;
  return segs.reduce((a, s) => a + s.confidence * (s.end - s.start), 0) / total;
}

function ncShareOf(result: AnalysisResult): number {
  const dur = result.duration;
  if (dur <= 0) return 0;
  const nc = result.segments
    .filter((s) => s.chord === NO_CHORD)
    .reduce((a, s) => a + (s.end - s.start), 0);
  return nc / dur;
}

const r4 = (v: number) => Math.round(v * 10000) / 10000;
const pct1 = (v: number) => Math.round(v * 1000) / 10;

export interface MicSongConditionResult {
  rootAccuracyPct: number;
  triadAccuracyPct: number;
  triadCountedSec: number;
  coreAccuracyPct: number | null;
  coreCountedSec: number;
  ncSharePct: number;
  meanConfidence: number;
  detectedKey: string;
  detectedBpm: number | null;
  topConfusions: { gt: string; det: string; sec: number }[];
}

export async function runMicInput(): Promise<Record<string, unknown>> {
  const specs = STEM_SONGS.filter((s) => s.slug !== "song-d");
  const out: Record<string, unknown> = {
    harness: "scripts/measureMicInput.ts（簡易モード相当: 混合音・既定オプション {}）",
    generatedAt: new Date().toISOString(),
    params: {
      conditions: MIC_CONDITIONS,
      prng: "mulberry32（シードは条件パラメータ内に記載）",
      irSpec:
        "周波数領域合成（ランダム位相＋平坦振幅、帯域端 30Hz/18kHz のみ整形）→ 指数減衰包絡（RT60 で -60dB）→ 単位エネルギー正規化、長さ = min(RT60×3, 2.5s)。暗色化は入れない（入れると再正規化で低域ゲインが膨らむため）。wet 比は診断で入力3種とも ±2dB 以内を確認済み",
      noiseSpec:
        "ホワイトノイズを 1 ポール LP 400Hz で低域寄りに整形。SNR は信号全区間 RMS に対する広帯域比",
      bandSpec: "RBJ バイカッド（Q=0.707）。段数は条件パラメータの stages",
      compSpec: "ピーク包絡フォロワ（attack/release は条件パラメータ）、メイクアップなし",
      levelSpec: "劣化条件は最後にピーク 0.95 へ正規化（録音側のレベル調整の近似）。clean は無加工",
    },
    realSongs: [] as unknown[],
    suno05: null as unknown,
  };

  const realSongs: unknown[] = [];
  for (const spec of specs) {
    const truth: RealTruth = parseTruthJson(
      JSON.parse(readFileSync(spec.truthPath, "utf-8")),
      spec.slug,
    );
    const audio = loadAudioFile(spec.mixPath);
    const conditions: Record<string, MicSongConditionResult> = {};
    for (const cond of MIC_CONDITIONS) {
      const degraded = degrade(audio.samples, audio.sampleRate, cond);
      const result = await analyzeAudio(degraded, audio.sampleRate, spec.slug, undefined, {});
      const m = measureRealSong(truth, result, "default");
      conditions[cond.id] = {
        rootAccuracyPct: pct1(m.rootAccuracy),
        triadAccuracyPct: pct1(m.triadAccuracy),
        triadCountedSec: Math.round(m.triadCountedSec * 10) / 10,
        coreAccuracyPct: m.coreAccuracy === null ? null : pct1(m.coreAccuracy),
        coreCountedSec: Math.round(m.coreCountedSec * 10) / 10,
        ncSharePct: pct1(m.ncShare),
        meanConfidence: r4(meanConfidence(result)),
        detectedKey: m.detectedKey,
        detectedBpm: m.detectedBpm,
        topConfusions: m.confusions.slice(0, 3).map((c) => ({
          gt: c.gt,
          det: c.det,
          sec: Math.round(c.sec * 100) / 100,
        })),
      };
      console.log(
        `[mic-input] ${spec.slug} / ${cond.id}: root ${conditions[cond.id].rootAccuracyPct}% triad ${conditions[cond.id].triadAccuracyPct}% nc ${conditions[cond.id].ncSharePct}%`,
      );
    }
    realSongs.push({
      slug: spec.slug,
      title: spec.title,
      durationSec: Math.round((audio.samples.length / audio.sampleRate) * 10) / 10,
      sampleRate: audio.sampleRate,
      conditions,
    });
  }
  out.realSongs = realSongs;

  // Suno 05（宵のひかり）: 全曲正解は無いためフィクスチャ＋全体統計で観察する
  const mix05 = loadAudioFile(MIX05_PATH);
  const cond05: Record<string, unknown> = {};
  for (const cond of MIC_CONDITIONS) {
    const degraded = degrade(mix05.samples, mix05.sampleRate, cond);
    const result = await analyzeAudio(degraded, mix05.sampleRate, "05.mp3", undefined, {});
    cond05[cond.id] = {
      ncSharePct: pct1(ncShareOf(result)),
      meanConfidence: r4(meanConfidence(result)),
      segmentCount: result.segments.length,
      detectedKey: result.keyName,
      detectedBpm: result.bpm,
      fixtures: fixtures05(result),
    };
    console.log(
      `[mic-input] suno05 / ${cond.id}: nc ${(cond05[cond.id] as { ncSharePct: number }).ncSharePct}% conf ${(cond05[cond.id] as { meanConfidence: number }).meanConfidence}`,
    );
  }
  out.suno05 = {
    durationSec: Math.round((mix05.samples.length / mix05.sampleRate) * 10) / 10,
    sampleRate: mix05.sampleRate,
    conditions: cond05,
  };

  mkdirSync(MIC_OUT_DIR, { recursive: true });
  writeFileSync(RESULTS_PATH, JSON.stringify(out, null, 2) + "\n", "utf-8");
  return out;
}

export function micInputReady(): boolean {
  const specs = STEM_SONGS.filter((s) => s.slug !== "song-d");
  return (
    existsSync(MIX05_PATH) &&
    specs.every((s) => existsSync(s.mixPath) && existsSync(s.truthPath))
  );
}

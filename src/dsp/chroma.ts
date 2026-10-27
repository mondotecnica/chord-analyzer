import { fftMagnitudes, hannWindow } from "./fft";
import { accumulateLowBandChroma, createLowBandBinMap } from "./bass";

/**
 * STFT ベースのクロマグラム（HPCP 風）計算。
 *
 * - 設定は CHROMA_CONFIG に集約し、後フェーズで差し替え可能にする。
 * - 各 FFT ビンを「最も近い MIDI ノートのピッチクラス」に寄与させる。
 * - 低域（ルート感）と高域のバランスのため、周波数に対する緩やかな重み付けを行う。
 * - 同時にスペクトルフラックス（オンセット包絡）も返し、テンポ推定に使う。
 * - コード判定専用のクロマ（chordFrames）も同時に返す。オプションで
 *   ベース帯域（境界周波数未満）を弱めた「上帯域クロマ」を作れる。
 *   分数コードでは強い低音が全帯域クロマを引っ張ってルートがベース音側に
 *   崩れる（Phase 1 Step 2 の所見）ため、コード楽器の帯域だけで判定する
 *   ための変種。消費側の使い分けは analyze.ts 側の判断（キー推定や
 *   モード決め直しは全帯域の frames を使う）。
 */

/**
 * コード判定用クロマの帯域設定（上帯域クロマ対策）。
 * cutoffHz 未満のビンの寄与を belowWeight 倍する（0 でハードカット）。
 * 境界の初期値は bass.ts の BASS_CONFIG.maxFreq（260Hz）に合わせるのが基本。
 */
export interface ChromaBandOptions {
  cutoffHz: number;
  belowWeight: number;
}

/** 周波数に対する帯域重み（cutoffHz 未満は belowWeight、それ以外は 1） */
export function chordBandWeight(freq: number, band: ChromaBandOptions): number {
  return freq < band.cutoffHz ? band.belowWeight : 1;
}

export const CHROMA_CONFIG = {
  fftSize: 4096,
  hopSize: 2048,
  minFreq: 50, // Hz: これ未満はノイズとして除外
  maxFreq: 5000, // Hz: これ以上はコード判定への寄与が薄い
} as const;

export interface ChromaResult {
  /** [frame][12] のクロマベクトル（各フレーム L1 正規化済み、無音フレームは全 0） */
  frames: Float32Array[];
  /**
   * [frame][12] のコード判定専用クロマ（L1 正規化済み）。
   * 帯域オプション未指定時は frames と同一（同じ配列を指す）。
   * 指定時はベース帯域を弱めた上帯域クロマになる。
   */
  chordFrames: Float32Array[];
  /** フレーム間隔（秒） */
  frameDuration: number;
  /** フレームごとの RMS エネルギー */
  energies: Float32Array;
  /** フレームごとのスペクトルフラックス（オンセット包絡、テンポ推定用） */
  onsetEnvelope: Float32Array;
  /**
   * [frame][12] の低域ピッチクラス分布（未正規化、Phase 1 のベース解析用）。
   * 集計・正規化は bass.ts の aggregateBassDistribution が担う。
   */
  bassFrames: Float32Array[];
}

export function computeChromagram(
  samples: Float32Array,
  sampleRate: number,
  onProgress?: (ratio: number) => void,
  options?: { chordBand?: ChromaBandOptions | null },
): ChromaResult {
  const { fftSize, hopSize, minFreq, maxFreq } = CHROMA_CONFIG;
  const band = options?.chordBand ?? null;
  const win = hannWindow(fftSize);
  const numFrames = Math.max(
    1,
    Math.floor((samples.length - fftSize) / hopSize) + 1,
  );

  // ビン → ピッチクラスと重みの事前計算
  const binCount = fftSize / 2;
  const binPitchClass = new Int16Array(binCount).fill(-1);
  const binWeight = new Float32Array(binCount);
  // コード判定用クロマのビン重み（帯域オプション時は低域を弱める）
  const binChordWeight = new Float32Array(binCount);
  for (let b = 0; b < binCount; b++) {
    const freq = (b * sampleRate) / fftSize;
    if (freq < minFreq || freq > maxFreq) continue;
    const midi = 69 + 12 * Math.log2(freq / 440);
    const pc = ((Math.round(midi) % 12) + 12) % 12;
    binPitchClass[b] = pc;
    // 高域ほど倍音が多くなるため、周波数に対して緩やかに減衰させる
    binWeight[b] = 1 / (1 + Math.log2(freq / minFreq) * 0.35);
    binChordWeight[b] = band
      ? binWeight[b] * chordBandWeight(freq, band)
      : binWeight[b];
  }

  // 低域ぶんのビン対応表（計算自体は bass.ts の責務）
  const bassBinMap = createLowBandBinMap(sampleRate, fftSize);

  const frames: Float32Array[] = [];
  const chordFrames: Float32Array[] = [];
  const bassFrames: Float32Array[] = [];
  const energies = new Float32Array(numFrames);
  const onsetEnvelope = new Float32Array(numFrames);
  const frame = new Float32Array(fftSize);
  let prevMags: Float32Array | null = null;

  for (let f = 0; f < numFrames; f++) {
    const offset = f * hopSize;
    let rms = 0;
    for (let i = 0; i < fftSize; i++) {
      const v = samples[offset + i] ?? 0;
      frame[i] = v * win[i];
      rms += v * v;
    }
    energies[f] = Math.sqrt(rms / fftSize);

    const mags = fftMagnitudes(frame);

    // スペクトルフラックス（正の増加分のみ）
    if (prevMags) {
      let flux = 0;
      for (let b = 0; b < binCount; b++) {
        const d = mags[b] - prevMags[b];
        if (d > 0) flux += d;
      }
      onsetEnvelope[f] = flux;
    }
    prevMags = mags;

    const chroma = new Float32Array(12);
    const chordChroma = new Float32Array(12);
    let sum = 0;
    let chordSum = 0;
    for (let b = 0; b < binCount; b++) {
      const pc = binPitchClass[b];
      if (pc < 0) continue;
      const contrib = mags[b] * binWeight[b];
      chroma[pc] += contrib;
      sum += contrib;
      const chordContrib = mags[b] * binChordWeight[b];
      chordChroma[pc] += chordContrib;
      chordSum += chordContrib;
    }
    if (sum > 0) {
      for (let p = 0; p < 12; p++) chroma[p] /= sum;
    }
    if (chordSum > 0) {
      for (let p = 0; p < 12; p++) chordChroma[p] /= chordSum;
    }
    frames.push(chroma);
    chordFrames.push(chordChroma);

    // 同じスペクトルから低域分布も取る（Phase 1 用、第 2 パスは回さない）
    const bass = new Float32Array(12);
    accumulateLowBandChroma(mags, bassBinMap, bass);
    bassFrames.push(bass);

    if (onProgress && f % 200 === 0) onProgress(f / numFrames);
  }
  if (onProgress) onProgress(1);

  return {
    frames,
    // 帯域オプション未指定時は全帯域クロマそのもの（Phase 0 の再現性のため）
    chordFrames: band ? chordFrames : frames,
    frameDuration: hopSize / sampleRate,
    energies,
    onsetEnvelope,
    bassFrames,
  };
}

/**
 * 低域ピッチクラス推定（Phase 1: ベース解析）。
 *
 * 責務は「低域（ベースの基本波が主になる帯域）のピッチクラス分布を出すこと」だけ。
 * コード推定・補正の判断は analysis 側（bassCorrection.ts）が行い、
 * ここでは UI やコード名には一切触れない（LEGO 的な分離、DESIGN_NOTES.md 参照）。
 *
 * 計算は chroma.ts の STFT ループから呼ばれる前提で、FFT 振幅スペクトルを
 * 受け取って低域ぶんだけをピッチクラスへ集計する関数として切り出してある。
 * これにより chroma.ts の責務（全帯域クロマ＋フラックス）を広げずに済む。
 */

export const BASS_CONFIG = {
  /** 対象帯域の下限 Hz（現行クロマの下限 50Hz と整合） */
  minFreq: 50,
  /** 対象帯域の上限 Hz（ベースの基本波＋低い倍音が主になる範囲） */
  maxFreq: 260,
} as const;

/** ビン → ピッチクラスの事前計算結果（低域帯域外のビンは -1） */
export interface LowBandBinMap {
  binPitchClass: Int16Array;
  binCount: number;
  /** 1 ビンの周波数幅（Hz） */
  freqPerBin: number;
}

/** 低域帯域ぶんのビン → ピッチクラス対応表を作る */
export function createLowBandBinMap(
  sampleRate: number,
  fftSize: number,
): LowBandBinMap {
  const binCount = fftSize / 2;
  const binPitchClass = new Int16Array(binCount).fill(-1);
  for (let b = 0; b < binCount; b++) {
    const freq = (b * sampleRate) / fftSize;
    if (freq < BASS_CONFIG.minFreq || freq > BASS_CONFIG.maxFreq) continue;
    const midi = 69 + 12 * Math.log2(freq / 440);
    binPitchClass[b] = ((Math.round(midi) % 12) + 12) % 12;
  }
  return { binPitchClass, binCount, freqPerBin: sampleRate / fftSize };
}

/**
 * 1 フレームの FFT 振幅スペクトルから、低域ピッチクラス分布（未正規化）を
 * out（12 次元）に加算する。
 *
 * 低域はビン幅（44.1kHz / 4096 ≒ 10.8Hz）が半音間隔（E2–F2 で約 5Hz）より
 * 広く、ビンごとに最寄りの音名へ割り振る方式では基本波のエネルギーが
 * 隣の半音へ漏れてしまう。そのため、ここでは低域全体の総量を
 * 「スペクトルピークの周波数（放物線補間で推定）に対応するピッチクラス」へ
 * 寄せる方式にする。基本波が倍音より大きいという前提のもとで、
 * フレーム単位のピーク投票をエネルギー加重で集計する形になる。
 */
export function accumulateLowBandChroma(
  mags: ArrayLike<number>,
  map: LowBandBinMap,
  out: Float32Array,
): void {
  let total = 0;
  let peakBin = -1;
  let peakVal = 0;
  for (let b = 0; b < map.binCount; b++) {
    if (map.binPitchClass[b] < 0) continue;
    total += mags[b];
    if (mags[b] > peakVal) {
      peakVal = mags[b];
      peakBin = b;
    }
  }
  if (peakBin < 0 || total <= 0) return;

  // ピーク位置を放物線補間でサブビン精度にする
  let delta = 0;
  if (peakBin > 0 && peakBin < mags.length - 1) {
    const a = mags[peakBin - 1];
    const b = mags[peakBin];
    const c = mags[peakBin + 1];
    const denom = a - 2 * b + c;
    if (denom !== 0) {
      delta = Math.max(-1, Math.min(1, (0.5 * (a - c)) / denom));
    }
  }
  const peakFreq = (peakBin + delta) * map.freqPerBin;
  if (peakFreq <= 0) return;
  const midi = 69 + 12 * Math.log2(peakFreq / 440);
  const pc = ((Math.round(midi) % 12) + 12) % 12;
  out[pc] += total;
}

/** フレームごとの低域総量（分布の要素合計）を返す */
export function lowBandFrameTotal(frame: ArrayLike<number>): number {
  let s = 0;
  for (let p = 0; p < 12; p++) s += frame[p];
  return s;
}

/** 低域ピッチクラス分布の集計結果 */
export interface BassDistribution {
  /** 12 次元、合計 1 に正規化済みの分布（総量 0 のときは全 0） */
  distribution: Float32Array;
  /** 正規化前の総量（エネルギー量の目安） */
  total: number;
  /** 最も大きいピッチクラス */
  topPc: number;
  /** トップのシェア（0..1） */
  topShare: number;
  /** トップ − 2 位のシェア差（0..1） */
  margin: number;
}

/**
 * フレーム列 [startIdx, endIdx) の低域分布を集計する。
 * 生の（未正規化）分布をそのまま足し合わせるため、低域エネルギーの
 * 大きいフレームが自然に重く効く＝エネルギー加重平均になる。
 */
export function aggregateBassDistribution(
  bassFrames: Float32Array[],
  startIdx: number,
  endIdx: number,
): BassDistribution {
  const sum = new Float32Array(12);
  let total = 0;
  const from = Math.max(0, startIdx);
  const to = Math.min(bassFrames.length, endIdx);
  for (let i = from; i < to; i++) {
    const f = bassFrames[i];
    for (let p = 0; p < 12; p++) {
      sum[p] += f[p];
      total += f[p];
    }
  }
  const distribution = new Float32Array(12);
  let topPc = 0;
  let topShare = 0;
  let secondShare = 0;
  if (total > 0) {
    for (let p = 0; p < 12; p++) {
      distribution[p] = sum[p] / total;
      if (distribution[p] > topShare) {
        secondShare = topShare;
        topShare = distribution[p];
        topPc = p;
      } else if (distribution[p] > secondShare) {
        secondShare = distribution[p];
      }
    }
  }
  return {
    distribution,
    total,
    topPc,
    topShare,
    margin: topShare - secondShare,
  };
}

/** 曲全体の低域フレーム総量の中央値（証拠の強さの相対基準に使う） */
export function medianLowBandFrameTotal(bassFrames: Float32Array[]): number {
  if (bassFrames.length === 0) return 0;
  const totals = bassFrames.map(lowBandFrameTotal).sort((a, b) => a - b);
  return totals[Math.floor(totals.length / 2)] ?? 0;
}

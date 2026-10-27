/**
 * FFT（Cooley–Tukey, 基数2）と窓関数。
 * 外部ライブラリに依存せず、ブラウザ内だけで動作するための自前実装。
 */

/**
 * 実数入力（長さは 2 の冪）に対する FFT のマグニチュード（前半 N/2 本）を返す。
 */
export function fftMagnitudes(input: Float32Array): Float32Array {
  const n = input.length;
  if (n === 0 || (n & (n - 1)) !== 0) {
    throw new Error(`FFT size must be a power of two, got ${n}`);
  }
  const re = new Float64Array(input);
  const im = new Float64Array(n);

  // ビット反転並べ替え
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j &= ~bit;
    j |= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }

  // バタフライ演算
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const aRe = re[i + k];
        const aIm = im[i + k];
        const bIdx = i + k + len / 2;
        const bRe = re[bIdx] * curRe - im[bIdx] * curIm;
        const bIm = re[bIdx] * curIm + im[bIdx] * curRe;
        re[i + k] = aRe + bRe;
        im[i + k] = aIm + bIm;
        re[bIdx] = aRe - bRe;
        im[bIdx] = aIm - bIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }

  const half = n / 2;
  const mags = new Float32Array(half);
  for (let i = 0; i < half; i++) {
    mags[i] = Math.sqrt(re[i] * re[i] + im[i] * im[i]);
  }
  return mags;
}

/** Hann 窓を生成する */
export function hannWindow(size: number): Float32Array {
  const w = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)));
  }
  return w;
}

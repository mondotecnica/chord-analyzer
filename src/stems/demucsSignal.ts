import {
  MODEL_FFT_SIZE,
  MODEL_HOP_SIZE,
  MODEL_SEGMENT_SAMPLES,
  MODEL_SPEC_BINS,
  MODEL_SPEC_FRAMES,
} from "./config";

/**
 * HTDemucs ONNX（埋め込み型エクスポート）の前後処理。
 *
 * この ONNX モデルは波形を直接入出力する形ではなく、demucs-web
 * プロジェクト（timcsy/demucs-web）が公開している方式に合わせて
 * - 入力1: 波形 [1, 2, 343980]
 * - 入力2: 複素スペクトログラム [1, 4, 2048, 336]
 *   （ch = L実部 / L虚部 / R実部 / R虚部、STFT は呼び出し側で計算）
 * - 出力: 時間領域 [1, 4, 2, 343980] と周波数領域 [1, 4, 4, 2048, 336]
 *   の 2 本立てで、最終波形は「時間出力 + iSTFT(周波数出力)」
 * を取る。本モジュールはその STFT / iSTFT と整形を担う純粋関数群で、
 * パラメータと数値規約（周期 Hann 窓、1/√N スケーリング、反射パディング、
 * フレームオフセット 2 等）は同プロジェクトの公開実装に一致させてある。
 * 単体テストで STFT→iSTFT の往復一致までを検証し、モデル実推論との
 * 結合はブラウザ実機での未検証項目として MODES.md §8 に明記する。
 */

// ---------------------------------------------------------------------------
// FFT（基数 2、イテレーティブ。回転因子はサイズごとにキャッシュ）
// ---------------------------------------------------------------------------

const twiddleCache = new Map<string, { real: Float32Array; imag: Float32Array }>();

function getTwiddles(n: number, inverse: boolean): { real: Float32Array; imag: Float32Array } {
  const key = `${inverse ? "i" : "f"}:${n}`;
  const cached = twiddleCache.get(key);
  if (cached) return cached;
  const real = new Float32Array(n / 2);
  const imag = new Float32Array(n / 2);
  const sign = inverse ? 1 : -1;
  for (let k = 0; k < n / 2; k++) {
    const angle = (sign * 2 * Math.PI * k) / n;
    real[k] = Math.cos(angle);
    imag[k] = Math.sin(angle);
  }
  const tw = { real, imag };
  twiddleCache.set(key, tw);
  return tw;
}

function bitReverse(x: number, bits: number): number {
  let result = 0;
  let v = x;
  for (let i = 0; i < bits; i++) {
    result = (result << 1) | (v & 1);
    v >>= 1;
  }
  return result;
}

function fftButterfly(
  realOut: Float32Array,
  imagOut: Float32Array,
  realIn: Float32Array,
  imagIn: Float32Array,
  n: number,
  inverse: boolean,
): void {
  const bits = Math.log2(n) | 0;
  const twiddles = getTwiddles(n, inverse);
  for (let i = 0; i < n; i++) {
    const j = bitReverse(i, bits);
    realOut[i] = realIn[j];
    imagOut[i] = imagIn[j];
  }
  for (let size = 2; size <= n; size *= 2) {
    const halfSize = size / 2;
    const step = n / size;
    for (let i = 0; i < n; i += size) {
      for (let j = 0; j < halfSize; j++) {
        const k = j * step;
        const tReal = twiddles.real[k];
        const tImag = twiddles.imag[k];
        const idx1 = i + j;
        const idx2 = i + j + halfSize;
        const eReal = realOut[idx1];
        const eImag = imagOut[idx1];
        const oReal = realOut[idx2] * tReal - imagOut[idx2] * tImag;
        const oImag = realOut[idx2] * tImag + imagOut[idx2] * tReal;
        realOut[idx1] = eReal + oReal;
        imagOut[idx1] = eImag + oImag;
        realOut[idx2] = eReal - oReal;
        imagOut[idx2] = eImag - oImag;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) {
      realOut[i] /= n;
      imagOut[i] /= n;
    }
  }
}

/** 実数入力の FFT */
export function fftReal(input: Float32Array, n: number): { real: Float32Array; imag: Float32Array } {
  const real = new Float32Array(n);
  const imag = new Float32Array(n);
  fftButterfly(real, imag, input, new Float32Array(n), n, false);
  return { real, imag };
}

/** 複素入力の逆 FFT（1/N スケーリング込み） */
export function ifftComplex(
  realIn: Float32Array,
  imagIn: Float32Array,
  n: number,
): { real: Float32Array; imag: Float32Array } {
  const real = new Float32Array(n);
  const imag = new Float32Array(n);
  fftButterfly(real, imag, realIn, imagIn, n, true);
  return { real, imag };
}

// ---------------------------------------------------------------------------
// STFT / iSTFT（周期 Hann 窓、STFT は 1/√N、iSTFT は √N + WOLA 正規化）
// ---------------------------------------------------------------------------

const hannCache = new Map<number, Float32Array>();

/** 周期 Hann 窓（w[i] = 0.5 * (1 - cos(2πi / n))） */
export function periodicHannWindow(size: number): Float32Array {
  const cached = hannCache.get(size);
  if (cached) return cached;
  const window = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / size));
  }
  hannCache.set(size, window);
  return window;
}

export interface ComplexSpectrogram {
  /** [frame][bin] レイアウト */
  real: Float32Array;
  imag: Float32Array;
  numFrames: number;
  numBins: number;
}

export function stft(
  signal: Float32Array,
  fftSize: number,
  hopSize: number,
): ComplexSpectrogram {
  const numFrames = Math.floor((signal.length - fftSize) / hopSize) + 1;
  const numBins = fftSize / 2 + 1;
  const window = periodicHannWindow(fftSize);
  const scale = 1.0 / Math.sqrt(fftSize);
  const real = new Float32Array(numFrames * numBins);
  const imag = new Float32Array(numFrames * numBins);
  const windowed = new Float32Array(fftSize);

  for (let frame = 0; frame < numFrames; frame++) {
    const start = frame * hopSize;
    for (let i = 0; i < fftSize; i++) {
      windowed[i] = signal[start + i] * window[i];
    }
    const out = fftReal(windowed, fftSize);
    const outOffset = frame * numBins;
    for (let k = 0; k < numBins; k++) {
      real[outOffset + k] = out.real[k] * scale;
      imag[outOffset + k] = out.imag[k] * scale;
    }
  }
  return { real, imag, numFrames, numBins };
}

export function istft(
  spec: ComplexSpectrogram,
  fftSize: number,
  hopSize: number,
  length?: number,
): Float32Array {
  const { numFrames, numBins } = spec;
  const outputLength = length ?? (numFrames - 1) * hopSize + fftSize;
  const output = new Float32Array(outputLength);
  const windowSum = new Float32Array(outputLength);
  const window = periodicHannWindow(fftSize);
  const scale = Math.sqrt(fftSize);

  const fullReal = new Float32Array(fftSize);
  const fullImag = new Float32Array(fftSize);

  for (let frame = 0; frame < numFrames; frame++) {
    fullReal.fill(0);
    fullImag.fill(0);
    for (let k = 0; k < numBins; k++) {
      fullReal[k] = spec.real[frame * numBins + k];
      fullImag[k] = spec.imag[frame * numBins + k];
    }
    // エルミート対称で負周波数側を復元する
    for (let k = 1; k < numBins - 1; k++) {
      fullReal[fftSize - k] = fullReal[k];
      fullImag[fftSize - k] = -fullImag[k];
    }
    const out = ifftComplex(fullReal, fullImag, fftSize);
    const start = frame * hopSize;
    for (let i = 0; i < fftSize && start + i < outputLength; i++) {
      output[start + i] += out.real[i] * window[i] * scale;
      windowSum[start + i] += window[i] * window[i];
    }
  }
  for (let i = 0; i < outputLength; i++) {
    if (windowSum[i] > 1e-8) output[i] /= windowSum[i];
  }
  return output;
}

/** 反射パディング（端の繰り返しなし、PyTorch の reflect と同じ規約） */
export function reflectPad(
  signal: Float32Array,
  padLeft: number,
  padRight: number,
): Float32Array {
  const length = signal.length;
  const output = new Float32Array(padLeft + length + padRight);
  for (let i = 0; i < padLeft; i++) {
    const srcIdx = Math.min(padLeft - i, length - 1);
    output[i] = signal[srcIdx];
  }
  output.set(signal, padLeft);
  for (let i = 0; i < padRight; i++) {
    const srcIdx = Math.max(0, length - 2 - i);
    output[padLeft + length + i] = signal[srcIdx];
  }
  return output;
}

// ---------------------------------------------------------------------------
// モデル入出力の整形（demucs-web の prepareModelInput / standaloneMask /
// standaloneIspec と同じレイアウト）
// ---------------------------------------------------------------------------

export interface ModelInput {
  /** [2][343980] を連結した波形（L の後に R） */
  waveform: Float32Array;
  /** [4][2048][336]（ch = L実部 / L虚部 / R実部 / R虚部） */
  magSpec: Float32Array;
}

/**
 * ステレオ 1 セグメント（長さは MODEL_SEGMENT_SAMPLES 以下を想定、
 * 不足分はゼロ埋め）からモデル入力を作る。
 */
export function prepareModelInput(
  leftChannel: Float32Array,
  rightChannel: Float32Array,
): ModelInput {
  const inputLength = MODEL_SEGMENT_SAMPLES;
  const fftSize = MODEL_FFT_SIZE;
  const hopSize = MODEL_HOP_SIZE;
  const numBins = MODEL_SPEC_BINS;
  const numFrames = MODEL_SPEC_FRAMES;

  const paddedLeft = new Float32Array(inputLength);
  const paddedRight = new Float32Array(inputLength);
  const copyLen = Math.min(leftChannel.length, inputLength);
  paddedLeft.set(leftChannel.subarray(0, copyLen));
  paddedRight.set(rightChannel.subarray(0, copyLen));

  const le = Math.ceil(inputLength / hopSize);
  const pad = Math.floor(hopSize / 2) * 3;
  const padRight = pad + le * hopSize - inputLength;

  const stftInputLeft = reflectPad(paddedLeft, pad, padRight);
  const stftInputRight = reflectPad(paddedRight, pad, padRight);

  const centerPad = fftSize / 2;
  const centeredLeft = reflectPad(stftInputLeft, centerPad, centerPad);
  const centeredRight = reflectPad(stftInputRight, centerPad, centerPad);

  const stftLeft = stft(centeredLeft, fftSize, hopSize);
  const stftRight = stft(centeredRight, fftSize, hopSize);

  const frameOffset = 2;
  const magSpec = new Float32Array(4 * numBins * numFrames);
  for (let f = 0; f < numFrames; f++) {
    const srcFrame = f + frameOffset;
    for (let b = 0; b < numBins; b++) {
      const srcIdx = srcFrame * stftLeft.numBins + b;
      magSpec[0 * numBins * numFrames + b * numFrames + f] = stftLeft.real[srcIdx];
      magSpec[1 * numBins * numFrames + b * numFrames + f] = stftLeft.imag[srcIdx];
      magSpec[2 * numBins * numFrames + b * numFrames + f] = stftRight.real[srcIdx];
      magSpec[3 * numBins * numFrames + b * numFrames + f] = stftRight.imag[srcIdx];
    }
  }

  const waveform = new Float32Array(2 * inputLength);
  waveform.set(paddedLeft, 0);
  waveform.set(paddedRight, inputLength);

  return { waveform, magSpec };
}

export interface TrackSpectrogram {
  /** [bin][frame] レイアウト */
  leftReal: Float32Array;
  leftImag: Float32Array;
  rightReal: Float32Array;
  rightImag: Float32Array;
}

/** 周波数領域出力 [4track][4ch][2048][336] をトラック別スペクトログラムへ */
export function maskToSpectrograms(freqOutput: Float32Array): TrackSpectrogram[] {
  const numTracks = 4;
  const numChannels = 4;
  const numBins = MODEL_SPEC_BINS;
  const numFrames = MODEL_SPEC_FRAMES;
  const result: TrackSpectrogram[] = [];
  for (let t = 0; t < numTracks; t++) {
    const trackSpec: TrackSpectrogram = {
      leftReal: new Float32Array(numBins * numFrames),
      leftImag: new Float32Array(numBins * numFrames),
      rightReal: new Float32Array(numBins * numFrames),
      rightImag: new Float32Array(numBins * numFrames),
    };
    for (let f = 0; f < numFrames; f++) {
      for (let b = 0; b < numBins; b++) {
        const baseIdx = t * numChannels * numBins * numFrames;
        const outIdx = b * numFrames + f;
        trackSpec.leftReal[outIdx] = freqOutput[baseIdx + 0 * numBins * numFrames + b * numFrames + f];
        trackSpec.leftImag[outIdx] = freqOutput[baseIdx + 1 * numBins * numFrames + b * numFrames + f];
        trackSpec.rightReal[outIdx] = freqOutput[baseIdx + 2 * numBins * numFrames + b * numFrames + f];
        trackSpec.rightImag[outIdx] = freqOutput[baseIdx + 3 * numBins * numFrames + b * numFrames + f];
      }
    }
    result.push(trackSpec);
  }
  return result;
}

/** トラック別スペクトログラムを時間領域へ戻す（iSTFT とオフセット除去） */
export function spectrogramToWaveform(
  trackSpec: TrackSpectrogram,
  targetLength: number,
): { left: Float32Array; right: Float32Array } {
  const numBins = MODEL_SPEC_BINS;
  const numFrames = MODEL_SPEC_FRAMES;
  const hopLength = MODEL_HOP_SIZE;
  const paddedBins = numBins + 1;
  const paddedFrames = numFrames + 4;

  const padChannel = (real: Float32Array, imag: Float32Array): ComplexSpectrogram => {
    const paddedReal = new Float32Array(paddedFrames * paddedBins);
    const paddedImag = new Float32Array(paddedFrames * paddedBins);
    for (let f = 0; f < numFrames; f++) {
      for (let b = 0; b < numBins; b++) {
        const srcIdx = b * numFrames + f;
        const dstIdx = (f + 2) * paddedBins + b;
        paddedReal[dstIdx] = real[srcIdx];
        paddedImag[dstIdx] = imag[srcIdx];
      }
    }
    return { real: paddedReal, imag: paddedImag, numFrames: paddedFrames, numBins: paddedBins };
  };

  const leftPadded = padChannel(trackSpec.leftReal, trackSpec.leftImag);
  const rightPadded = padChannel(trackSpec.rightReal, trackSpec.rightImag);

  const centerPad = MODEL_FFT_SIZE / 2;
  const pad = Math.floor(hopLength / 2) * 3;
  const istftLength = (paddedFrames - 1) * hopLength + MODEL_FFT_SIZE;

  const leftOut = istft(leftPadded, MODEL_FFT_SIZE, hopLength, istftLength);
  const rightOut = istft(rightPadded, MODEL_FFT_SIZE, hopLength, istftLength);

  const totalOffset = centerPad + pad;
  return {
    left: new Float32Array(leftOut.subarray(totalOffset, totalOffset + targetLength)),
    right: new Float32Array(rightOut.subarray(totalOffset, totalOffset + targetLength)),
  };
}

/**
 * モデルの 2 出力（時間領域 + 周波数領域）を最終ステム波形へ合成する。
 * 周波数出力が無いモデルでは時間出力だけを使う。
 * timeDims は [1, 4, 2, samples] を想定する。
 */
export function combineModelOutputs(
  timeData: Float32Array,
  timeDims: readonly number[],
  freqData: Float32Array | null,
): { left: Float32Array; right: Float32Array }[] {
  if (timeDims.length !== 4 || timeDims[2] !== 2) {
    throw new Error(
      `モデルの時間領域出力の形状が想定と異なります（dims: ${timeDims.join("x")}）。`,
    );
  }
  const numTracks = timeDims[1];
  const numChannels = timeDims[2];
  const samples = timeDims[3];

  let freqWaveforms: { left: Float32Array; right: Float32Array }[] | null = null;
  if (freqData) {
    const trackSpecs = maskToSpectrograms(freqData);
    freqWaveforms = trackSpecs.map((spec) =>
      spectrogramToWaveform(spec, MODEL_SEGMENT_SAMPLES),
    );
  }

  const tracks: { left: Float32Array; right: Float32Array }[] = [];
  for (let t = 0; t < numTracks; t++) {
    const left = new Float32Array(samples);
    const right = new Float32Array(samples);
    for (let i = 0; i < samples; i++) {
      left[i] = timeData[t * numChannels * samples + 0 * samples + i];
      right[i] = timeData[t * numChannels * samples + 1 * samples + i];
      if (freqWaveforms) {
        left[i] += freqWaveforms[t].left[i] || 0;
        right[i] += freqWaveforms[t].right[i] || 0;
      }
    }
    tracks.push({ left, right });
  }
  return tracks;
}

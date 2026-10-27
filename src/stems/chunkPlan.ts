import {
  CHUNK_OVERLAP_SECONDS,
  CHUNK_SECONDS,
  MODEL_SEGMENT_OVERLAP_RATIO,
  MODEL_SEGMENT_SAMPLES,
} from "./config";

/**
 * 分離推論の窓計画とクロスフェード合成（純粋関数のみ、MODES.md §2.2）。
 *
 * 2 階層で同じ仕組みを使う:
 * - アプリ側チャンク: 曲を 30 秒窓（重なり 2.5 秒）で切る。
 *   メモリに載る量を bound し、進捗をチャンク単位で出すため。
 * - モデルセグメント: チャンク内をモデルの入力長 343,980 サンプル
 *   （重なり 25%）で切る。HTDemucs の apply_model と同じ考え方。
 *
 * 各窓は独立に推論し、重なり区間を三角窓の重みで加重平均して接続する
 * （重みの合計で割るため、窓の出力がすべて同じ信号なら元信号に一致する）。
 */

export interface SegmentWindow {
  index: number;
  /** 信号先頭からの開始位置（サンプル） */
  start: number;
  /** 窓の長さ（サンプル）。信号末尾ではみ出す分はゼロ埋め前提 */
  length: number;
}

/**
 * [0, totalLength) を長さ segmentLength の窓で覆う計画を返す。
 * 窓同士は overlapLength だけ重なり、最後の窓は信号末尾に届く。
 */
export function planSegments(
  totalLength: number,
  segmentLength: number,
  overlapLength: number,
): SegmentWindow[] {
  if (!Number.isFinite(totalLength) || totalLength < 0) {
    throw new Error("totalLength は 0 以上の有限値でなければなりません。");
  }
  if (!Number.isFinite(segmentLength) || segmentLength <= 0) {
    throw new Error("segmentLength は正の有限値でなければなりません。");
  }
  if (
    !Number.isFinite(overlapLength) ||
    overlapLength < 0 ||
    overlapLength >= segmentLength
  ) {
    throw new Error("overlapLength は 0 以上 segmentLength 未満でなければなりません。");
  }
  if (totalLength === 0) return [];
  const stride = segmentLength - overlapLength;
  const windows: SegmentWindow[] = [];
  for (let start = 0, index = 0; ; start += stride, index++) {
    windows.push({ index, start, length: segmentLength });
    if (start + segmentLength >= totalLength) break;
  }
  return windows;
}

/** アプリ側チャンク計画（MODES.md §2.3 の初期値 30 秒 / 2.5 秒） */
export function planSongChunks(
  totalSamples: number,
  sampleRate: number,
): SegmentWindow[] {
  return planSegments(
    totalSamples,
    Math.round(CHUNK_SECONDS * sampleRate),
    Math.round(CHUNK_OVERLAP_SECONDS * sampleRate),
  );
}

/** モデルセグメント計画（入力長 343,980、重なり 25%） */
export function planModelSegments(totalSamples: number): SegmentWindow[] {
  return planSegments(
    totalSamples,
    MODEL_SEGMENT_SAMPLES,
    Math.floor(MODEL_SEGMENT_SAMPLES * MODEL_SEGMENT_OVERLAP_RATIO),
  );
}

/** モデルセグメント合成時のフェード長（demucs-web と同じく stride の半分） */
export function modelSegmentFadeLength(): number {
  const stride =
    MODEL_SEGMENT_SAMPLES -
    Math.floor(MODEL_SEGMENT_SAMPLES * MODEL_SEGMENT_OVERLAP_RATIO);
  return Math.floor(stride / 2);
}

/**
 * 窓内オフセットに対するクロスフェード重み（0..1）。
 * fadeIn / fadeOut は「その側に隣の窓があるか」で切り替える。
 * 信号の先頭・末尾に接する側はフェードしない（重み 1 のまま）ことで、
 * 曲の最初と最後のサンプルが無音化しないようにする。
 */
export function segmentWeightAt(
  offset: number,
  segmentLength: number,
  fadeLength: number,
  edges: { fadeIn: boolean; fadeOut: boolean },
): number {
  if (fadeLength <= 0) return 1;
  let w = 1;
  if (edges.fadeIn) w = Math.min(w, offset / fadeLength);
  if (edges.fadeOut) w = Math.min(w, (segmentLength - offset) / fadeLength);
  return Math.max(0, Math.min(1, w));
}

export interface SegmentOutput {
  /** 信号先頭からの開始位置（planSegments の start と対応） */
  start: number;
  /** チャンネルごとの窓出力。すべて同じ長さ */
  channels: Float32Array[];
}

/**
 * 窓ごとの出力を重み付き平均で 1 本の信号に合成する。
 * 重みは窓の重なり側だけにフェードを付け、信号端ではフェードしない。
 * 覆われていない位置は 0 のままになる（planSegments で計画すれば
 * [0, totalLength) はすべて覆われる）。
 */
export function assembleSegments(
  totalLength: number,
  outputs: SegmentOutput[],
  fadeLength: number,
): Float32Array[] {
  if (outputs.length === 0) return [];
  const channelCount = outputs[0].channels.length;
  const sums: Float32Array[] = [];
  for (let c = 0; c < channelCount; c++) sums.push(new Float32Array(totalLength));
  const weights = new Float32Array(totalLength);

  for (const output of outputs) {
    if (output.channels.length !== channelCount) {
      throw new Error("窓ごとにチャンネル数が一致しません。");
    }
    const length = output.channels[0].length;
    for (const ch of output.channels) {
      if (ch.length !== length) {
        throw new Error("窓内のチャンネル長が一致しません。");
      }
    }
    const edges = {
      fadeIn: output.start > 0,
      fadeOut: output.start + length < totalLength,
    };
    for (let i = 0; i < length; i++) {
      const pos = output.start + i;
      if (pos < 0) continue;
      if (pos >= totalLength) break;
      const w = segmentWeightAt(i, length, fadeLength, edges);
      if (w <= 0) continue;
      weights[pos] += w;
      for (let c = 0; c < channelCount; c++) {
        sums[c][pos] += output.channels[c][i] * w;
      }
    }
  }
  for (let pos = 0; pos < totalLength; pos++) {
    const w = weights[pos];
    if (w > 0) {
      for (let c = 0; c < channelCount; c++) sums[c][pos] /= w;
    }
  }
  return sums;
}

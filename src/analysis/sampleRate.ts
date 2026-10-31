import { resampleChannel } from "../stems/audioPrep";

/**
 * 解析サンプルレートの統一（48kHz クロマ異常への対策・方式 (a)）。
 *
 * 診断（measurements/SUNO_YOI_ANALYSIS.md の診断節）:
 * プロジェクトのクロマ（src/dsp/chroma.ts、FFT 4096 点・最近傍ビン
 * 割当て、低域ほど重みが大きい）は、48kHz 入力で低域の音高クラスを
 * 系統的に誤読する。48kHz では低域のビン間隔が半音間隔より粗く、
 * 「その音名に丸められるビン中心」が存在しない音域があり、エネルギーが
 * 隣の半音のビンへ落ちるためである。実測: 合成 Am 三和音が 48kHz で
 * C# minor と誤読され、44.1kHz では正常。実曲（05）を正しく 48kHz 化
 * した版も A# minor と誤読された。44.1kHz が無事なのはビン格子と
 * 音名格子の当たりが偶然良いためで、原理的な保証はない。
 *
 * 対策として、解析の全入口で入力を 44.1kHz に統一する:
 * - 全ての測定基準（合成曲・実曲・Suno 05 の蓄積）は 44.1kHz の
 *   現行クロマで較正されており、推定器そのものは変えない
 *   （クロマ自体の改修は measurements/CHROMA_48K_FIX.md の (b) 案）
 * - 簡易モードはブラウザのデコードレート（多くの PC / Android で
 *   48kHz）をそのまま受けていたため、この統一で初めて 48kHz 環境の
 *   劣化が解消される。高精度モードは従来から分離前に 44.1kHz へ
 *   リサンプルしており、その手段（stems/audioPrep の線形補間
 *   リサンプル）をそのまま再利用する
 * - 44.1kHz 入力では同一配列をそのまま返す（コピーもしない）ため、
 *   既存スイートの結果はビット一致する
 */

/** 解析パイプラインが前提とするサンプルレート [Hz] */
export const ANALYSIS_SAMPLE_RATE = 44100;

export interface AnalysisRateAudio {
  samples: Float32Array;
  /** 正規化後のサンプルレート（常に ANALYSIS_SAMPLE_RATE） */
  sampleRate: number;
}

/**
 * 入力サンプルを解析レートへ正規化する。44.1kHz 入力では
 * 同一参照・同一レートを返し、一切の数値変化を起こさない。
 */
export function normalizeToAnalysisRate(
  samples: Float32Array,
  sampleRate: number,
): AnalysisRateAudio {
  if (sampleRate === ANALYSIS_SAMPLE_RATE) {
    return { samples, sampleRate };
  }
  return {
    samples: resampleChannel(samples, sampleRate, ANALYSIS_SAMPLE_RATE),
    sampleRate: ANALYSIS_SAMPLE_RATE,
  };
}

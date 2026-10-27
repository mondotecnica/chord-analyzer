import { computeChromagram } from "../dsp/chroma";
import type { AnalysisResult } from "../types";
import { DEFAULT_CHORD_BAND, type AnalyzeProgress } from "./analyze";
import { applyBassCorrection } from "./bassCorrection";
import { estimateChordFrames } from "./chordEstimation";
import { estimateKey, estimateTempo } from "./keyTempo";
import { framesToSegments } from "./segmentation";
import { applyUpperBandMode } from "./splitBand";
import { applyConditionalUpperRoot } from "./conditionalBand";

/**
 * Phase 2: ステム入力の解析パイプライン（アプリ本体側）。
 *
 * 高精度モード（MODES.md）の解析段。分離済みステムを入力に取り、
 * 判定の中核（estimateChordFrames / framesToSegments /
 * applyBassCorrection / applyConditionalUpperRoot /
 * applyUpperBandMode）は混合音パイプラインと同一モジュールを使う。
 * 差し替えは「クロマと低域分布の出所」だけ:
 *
 *   analyzeAudio（混合音・split）の処理     ステム入力での出所
 *   ----------------------------------  --------------------------------
 *   フレーム判定の全帯域クロマ           other ステムの全帯域クロマ
 *   ベース補正の低域分布（bassFrames）   bass ステムから計算した低域分布
 *   ベース補正のスコア比較用クロマ       other ステムの全帯域クロマ
 *   モード決め直しの上帯域クロマ         other ステムの上帯域クロマ（260Hz）
 *   キー推定・テンポ推定                 混合音（Phase 1 と比較条件を揃える）
 *   vocals / drums ステム               コード判定には一切使わない
 *
 * 帯域戦略（other クロマの帯域の使い方）は named configs として持ち、
 * 測定ハーネス（scripts/measureStems.ts）が A/B 比較に使う。
 * アプリの高精度モードは A/B の勝者 s-conditional に固定する
 * （measurements/phase2/STEM_BAND_AB.md、MODES.md §1）。
 */

// ---------------------------------------------------------------------------
// ステム入力での帯域戦略（measurements/phase2/STEM_BAND_AB.md）
// ---------------------------------------------------------------------------

/**
 * 入力の割り当て（other = コード判定クロマ、bass ステム = 低域分布、
 * キー／テンポ = 混合音）は全戦略共通で、other クロマの帯域の
 * 使い方だけが違う。
 */
export type StemBandStrategy = "s-split" | "s-plain" | "s-unified" | "s-conditional";

export interface StemBandConfig {
  id: StemBandStrategy;
  label: string;
}

export const STEM_BAND_CONFIGS: StemBandConfig[] = [
  { id: "s-split", label: "分業（フレーム=other 全帯域、モードだけ other 上帯域 260Hz で決め直し）" },
  { id: "s-plain", label: "帯域操作なし（フレーム=other 全帯域、後段なし）" },
  { id: "s-unified", label: "上帯域一括（フレーム=other 上帯域 260Hz、後段なし）" },
  { id: "s-conditional", label: "条件分岐（分業＋崩壊セグメントだけルートも other 上帯域で決め直し）" },
];

/** 高精度モードで使う帯域戦略（A/B の勝者、STEM_BAND_AB.md） */
export const HIGH_ACCURACY_STEM_STRATEGY: StemBandStrategy = "s-conditional";

export interface StemChromas {
  mixChroma: ReturnType<typeof computeChromagram>;
  otherChroma: ReturnType<typeof computeChromagram>;
  bassChroma: ReturnType<typeof computeChromagram>;
  duration: number;
}

export function prepareStemChromas(
  mixSamples: Float32Array,
  otherSamples: Float32Array,
  bassSamples: Float32Array,
  sampleRate: number,
): StemChromas {
  return {
    // キー／テンポは混合音から（Phase 1 と比較条件を揃える）
    mixChroma: computeChromagram(mixSamples, sampleRate),
    // コード判定クロマは other ステムのみ。chordFrames は上帯域
    // （既定帯域 260Hz）版で、戦略ごとの後段処理に使う
    otherChroma: computeChromagram(otherSamples, sampleRate, undefined, {
      chordBand: DEFAULT_CHORD_BAND,
    }),
    // 低域分布は bass ステムから（混合音の低域を置き換える）
    bassChroma: computeChromagram(bassSamples, sampleRate),
    duration: otherSamples.length / sampleRate,
  };
}

/** 計算済みクロマから、指定した帯域戦略でステム解析を行う */
export function analyzeStemsWithStrategy(
  chromas: StemChromas,
  sampleRate: number,
  fileName: string,
  strategy: StemBandStrategy,
): AnalysisResult {
  const started = performance.now();
  const { mixChroma, otherChroma, bassChroma, duration } = chromas;
  const fd = otherChroma.frameDuration;
  // s-unified だけフレーム判定も上帯域クロマ。それ以外は全帯域
  const frameChroma =
    strategy === "s-unified" ? otherChroma.chordFrames : otherChroma.frames;
  const frames = estimateChordFrames(frameChroma, otherChroma.energies, fd);
  const key = estimateKey(mixChroma.frames);
  const bpm = estimateTempo(mixChroma.onsetEnvelope, mixChroma.frameDuration);

  let segments = framesToSegments(frames, fd, duration);
  // ベース補正は全戦略共通（低域分布 = bass ステム、スコア比較 = other 全帯域）
  segments = applyBassCorrection(
    segments,
    otherChroma.frames,
    bassChroma.bassFrames,
    otherChroma.energies,
    fd,
  );
  if (strategy === "s-conditional") {
    segments = applyConditionalUpperRoot(
      segments,
      otherChroma.chordFrames,
      bassChroma.bassFrames,
      otherChroma.energies,
      fd,
    );
  }
  if (strategy === "s-split" || strategy === "s-conditional") {
    segments = applyUpperBandMode(
      segments,
      otherChroma.chordFrames,
      otherChroma.energies,
      fd,
    );
  }

  return {
    fileName,
    duration,
    sampleRate,
    keyName: key.keyName,
    keyRoot: key.root,
    keyMode: key.mode,
    bpm,
    segments,
    analyzedInMs: Math.round(performance.now() - started),
  };
}

export function analyzeWithStems(
  mixSamples: Float32Array,
  otherSamples: Float32Array,
  bassSamples: Float32Array,
  sampleRate: number,
  fileName: string,
  strategy: StemBandStrategy = "s-split",
): AnalysisResult {
  const chromas = prepareStemChromas(mixSamples, otherSamples, bassSamples, sampleRate);
  return analyzeStemsWithStrategy(chromas, sampleRate, fileName, strategy);
}

// ---------------------------------------------------------------------------
// アプリの高精度モード入口（s-conditional 固定、進捗つき）
// ---------------------------------------------------------------------------

export interface StemAnalysisInput {
  /** 混合音（モノラル）。キー／テンポ推定にだけ使う */
  mixSamples: Float32Array;
  /** other ステム（モノラル）。コード判定クロマの出所 */
  otherSamples: Float32Array;
  /** bass ステム（モノラル）。低域分布の出所 */
  bassSamples: Float32Array;
  sampleRate: number;
  fileName: string;
  /** 分離モデル名（例: "htdemucs"）。結果のメタ情報に記録する */
  separationModel?: string;
  /** 分離本体にかかった秒数（実測がある場合）。結果へそのまま引き継ぐ */
  separationSeconds?: number;
}

const yieldToUi = () =>
  new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * 高精度モードの解析段。分離済みステム（メモリ内のみ）を受け取り、
 * s-conditional 構成で解析する。結果にはモードのメタ情報を付ける
 * （MODES.md §6）。
 */
export async function analyzeStemsAudio(
  input: StemAnalysisInput,
  onProgress?: (p: AnalyzeProgress) => void,
): Promise<AnalysisResult> {
  onProgress?.({ stage: "ステムからクロマグラムを計算中…", ratio: 0.05 });
  await yieldToUi();
  const chromas = prepareStemChromas(
    input.mixSamples,
    input.otherSamples,
    input.bassSamples,
    input.sampleRate,
  );

  onProgress?.({ stage: "コードを推定中…", ratio: 0.7 });
  await yieldToUi();
  const result = analyzeStemsWithStrategy(
    chromas,
    input.sampleRate,
    input.fileName,
    HIGH_ACCURACY_STEM_STRATEGY,
  );

  onProgress?.({ stage: "完了", ratio: 1 });
  return {
    ...result,
    mode: "high-accuracy",
    stemStrategy: HIGH_ACCURACY_STEM_STRATEGY,
    ...(input.separationModel
      ? { separationModel: input.separationModel }
      : {}),
    ...(typeof input.separationSeconds === "number"
      ? { separationSeconds: input.separationSeconds }
      : {}),
  };
}

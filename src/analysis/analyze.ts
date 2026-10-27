import { computeChromagram, type ChromaBandOptions } from "../dsp/chroma";
import { applyBassCorrection } from "./bassCorrection";
import { applyConditionalUpperRoot } from "./conditionalBand";
import { estimateChordFrames } from "./chordEstimation";
import { estimateKey, estimateTempo } from "./keyTempo";
import { framesToSegments } from "./segmentation";
import { applyUpperBandMode } from "./splitBand";
import type { AnalysisResult } from "../types";

/**
 * 解析パイプラインの統括（オーケストレータ）。
 *
 * パイプラインは段階ごとに独立モジュールへ分かれているので、
 * 後フェーズでは以下の差し替えが可能:
 * - Phase 1: ベース帯域だけのクロマ／ピッチ推定によるルート補正ステップ
 *            （bassCorrection.ts、実装済み。options.bassCorrection で無効化でき、
 *             Phase 0 ベースラインの再測定は無効化して行う）
 *            あわせて、コード判定にだけ上帯域クロマを使う変種
 *            （options.chordBand、分数コードのルート崩壊対策。
 *             measurements/PHASE1_UPPERBAND.md で測定・選定）
 * - Phase 1.5: 帯域分業（options.bandStrategy: "split"、splitBand.ts）。
 *            ルートは全帯域＋ベース補正、モードだけ上帯域で決め直す。
 *            実曲で「上帯域はモードに効くがルートに逆効果」だった
 *            ことへの対策（measurements/PHASE1_STEP3.md、PHASE1_5_HYBRID.md）
 *            2026-10-27、Step 3 実曲 3 曲の総括（PHASE1_SUMMARY.md）と
 *            ユーザー判断により、"split" がアプリの既定になった
 *            （bandStrategy 未指定 = "split"）。
 * - Phase 1.5b: 条件分岐（options.bandStrategy: "split-conditional"、
 *            conditionalBand.ts）。split の後段で、崩壊シグネチャ
 *            （ベースが構成音を強く鳴らしフレーム判定時点でルートが
 *            崩れた形）のあるセグメントだけ、ルートも上帯域で決め直す。
 *            Song D 型のルート崩壊と実曲型のモード反転をセグメント
 *            単位で切り分ける狙い（measurements/PHASE1_5B_CONDITIONAL.md）
 * - Phase 2: 前段に Demucs (ONNX) のステム分離を挿し、ステム別に解析
 * - Phase 3: chordEstimation のテンプレート集合を 7th / テンションへ拡張し、
 *            ジャンル事前分布を平滑化に組み込む
 */

export interface AnalyzeProgress {
  stage: string;
  ratio: number; // 0..1（全体進捗の目安）
}

export interface AnalyzeOptions {
  /** Phase 1 のベース補正を適用するか（既定: true） */
  bassCorrection?: boolean;
  /**
   * クロマの帯域設定（上帯域クロマ対策）。
   * undefined の場合は DEFAULT_CHORD_BAND、null で無効（全帯域クロマ）。
   * 使われ方は bandStrategy 依存: "unified" ではコード判定用帯域、
   * 既定の "split" ではモード判定用帯域になる（bandStrategy の説明を参照）。
   * キー推定とベース補正内のモード決め直しは、この設定によらず常に
   * 全帯域クロマを使う（使い分けの理由は measurements/PHASE1_UPPERBAND.md 参照）。
   */
  chordBand?: ChromaBandOptions | null;
  /**
   * Phase 1.5: 帯域分業（split）戦略。
   *
   * - "split"（既定）: ルートは全帯域クロマのフレーム判定＋ベース補正
   *   （実曲測定の "bass" 設定と同一手順・同一しきい値）で決め、
   *   モード（major/minor）だけを、確定セグメント単位で上帯域クロマ
   *   から決め直す（splitBand.ts の applyUpperBandMode）。
   *   この場合 chordBand は「モード判定用帯域」として解釈される
   *   （未指定なら DEFAULT_CHORD_BAND = 260Hz ハードカット）。
   *   chordBand: null を併用するとモードも全帯域セグメント平均で
   *   決め直す形になり分業の意味が消えるため、通常は併用しない。
   *   N.C. 判定・セグメント境界・信頼度は分業でも全帯域フレーム
   *   判定のまま変えない。キー推定・テンポ推定はどちらの戦略でも
   *   全帯域クロマ／オンセット包絡を使う（従来通り）。
   *   2026-10-27 にユーザーが既定化を決定した（根拠: 実曲 3 曲平均で
   *   全指標最良級、measurements/PHASE1_SUMMARY.md）。既知の代償として
   *   合成 Song D（分数コード）のルートは 26.7% に留まる
   *   （unified の 87.2% に対して）。この回帰は承知のうえで採用した。
   * - "unified"（明示指定時のみ）: コード判定（ルート＋モード）を
   *   chordBand のクロマで一括判定する、2026-10-27 までの旧既定の
   *   動作。chordBand 未指定なら DEFAULT_CHORD_BAND（260Hz 一括、
   *   実曲ハーネスの "unified260" 設定に相当）。履歴測定の再現は
   *   各ハーネスがこの値を明示固定して行う。
   * - "split-conditional"（Phase 1.5b）: "split" の処理に加えて、
   *   モード決め直しの前に conditionalBand.ts の
   *   applyConditionalUpperRoot を挟む。崩壊シグネチャ（低域の証拠が
   *   強く、ベース音＝検出ルートであり、上帯域候補がそのベース音を
   *   構成音に持つ別ルートで、スコア差がしきい値以上）のある
   *   セグメントだけ、ルート＋モードを上帯域候補で決め直す。
   *   シグネチャの無いセグメントは "split" と完全に同一の結果になる。
   */
  bandStrategy?: "unified" | "split" | "split-conditional";
}

/**
 * コード判定クロマの既定の帯域設定（上帯域クロマ）。
 *
 * 260Hz 未満（ベース帯域、BASS_CONFIG.maxFreq と一致）をコード判定から
 * ハードカットする。選定根拠は measurements/PHASE1_UPPERBAND.md:
 * バリアント比較（カットオフ 200/220/260Hz、減衰 ×0.25/×0.10）の中で
 * 唯一全受け入れ基準を通過し、Song D（分数コード）のルート正解率が
 * 26.7% → 87.2%、Songs A–C も 95.4%/86.4% → 96.9%/92.1% と悪化ではなく
 * 改善した。カットオフを下げるとコード楽器の下側の倍音まで削れて
 * 三和音正解率が落ち、減衰（ソフト）では中途半端な低域が残って
 * フレーム判定が不安定になった。
 *
 * この帯域の使われ方は bandStrategy で変わる: 既定の "split" では
 * モード判定用帯域として、"unified"（旧既定）ではコード判定用帯域として
 * 使われる。260Hz という値自体の選定は上記の上帯域測定に基づく。
 *
 * 履歴測定（Phase 0 / Step 1 / Step 2）は各ハーネス側で chordBand と
 * bandStrategy: "unified" を明示固定して再現性を保つ。
 * ここを変えるとアプリの既定動作だけが変わる。
 */
export const DEFAULT_CHORD_BAND: ChromaBandOptions | null = {
  cutoffHz: 260,
  belowWeight: 0,
};

const yieldToUi = () =>
  new Promise<void>((resolve) => setTimeout(resolve, 0));

export async function analyzeAudio(
  monoSamples: Float32Array,
  sampleRate: number,
  fileName: string,
  onProgress?: (p: AnalyzeProgress) => void,
  options?: AnalyzeOptions,
): Promise<AnalysisResult> {
  const started = performance.now();

  onProgress?.({ stage: "クロマグラムを計算中…", ratio: 0.05 });
  await yieldToUi();
  // 帯域戦略の既定は "split"（Phase 1.5 分業、2026-10-27 既定化）。
  // "unified" / "split-conditional" は明示指定時のみ。
  const bandStrategy = options?.bandStrategy ?? "split";
  const splitMode =
    bandStrategy === "split" || bandStrategy === "split-conditional";
  const conditionalMode = bandStrategy === "split-conditional";
  const chordBand =
    options?.chordBand !== undefined ? options.chordBand : DEFAULT_CHORD_BAND;
  const chroma = computeChromagram(
    monoSamples,
    sampleRate,
    (r) =>
      onProgress?.({ stage: "クロマグラムを計算中…", ratio: 0.05 + r * 0.55 }),
    { chordBand },
  );

  onProgress?.({ stage: "コードを推定中…", ratio: 0.65 });
  await yieldToUi();
  // コード判定（フレーム単位のテンプレート照合）だけが帯域つきクロマを使う。
  // キー推定・テンポ推定・ベース補正は全帯域クロマ／低域分布のまま。
  // 分業（split）ではフレーム判定も全帯域で行い（ルート決定は "bass"
  // 設定と同一手順にするため）、帯域つきクロマは後段のモード決め直し
  // （applyUpperBandMode）にだけ使う。
  const frames = estimateChordFrames(
    splitMode ? chroma.frames : chroma.chordFrames,
    chroma.energies,
    chroma.frameDuration,
  );

  onProgress?.({ stage: "キーとテンポを推定中…", ratio: 0.8 });
  await yieldToUi();
  const key = estimateKey(chroma.frames);
  const bpm = estimateTempo(chroma.onsetEnvelope, chroma.frameDuration);

  onProgress?.({ stage: "セグメントを整形中…", ratio: 0.9 });
  await yieldToUi();
  const duration = monoSamples.length / sampleRate;
  const phase0Segments = framesToSegments(frames, chroma.frameDuration, duration);

  // Phase 1: ベース解析によるルート補正（セグメント単位・保守ルール）
  let segments = phase0Segments;
  if (options?.bassCorrection !== false) {
    onProgress?.({ stage: "ベースでルートを補正中…", ratio: 0.95 });
    await yieldToUi();
    segments = applyBassCorrection(
      phase0Segments,
      chroma.frames,
      chroma.bassFrames,
      chroma.energies,
      chroma.frameDuration,
    );
  }

  // Phase 1.5b: 条件分岐（崩壊シグネチャのあるセグメントだけ、
  // ルートも上帯域クロマで決め直す）。split のモード決め直しより前に行う
  if (conditionalMode) {
    onProgress?.({ stage: "崩壊セグメントのルートを上帯域で決め直し中…", ratio: 0.96 });
    await yieldToUi();
    segments = applyConditionalUpperRoot(
      segments,
      chroma.chordFrames,
      chroma.bassFrames,
      chroma.energies,
      chroma.frameDuration,
    );
  }

  // Phase 1.5: 帯域分業（モードだけを上帯域クロマで決め直す）
  if (splitMode) {
    onProgress?.({ stage: "モードを上帯域で決め直し中…", ratio: 0.97 });
    await yieldToUi();
    segments = applyUpperBandMode(
      segments,
      chroma.chordFrames,
      chroma.energies,
      chroma.frameDuration,
    );
  }

  onProgress?.({ stage: "完了", ratio: 1 });

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

import { computeChromagram } from "../dsp/chroma";
import type {
  AnalysisResult,
  GenreProfile,
  MeterEstimate,
  ModelFetchSummary,
} from "../types";
import { DEFAULT_CHORD_BAND, type AnalyzeProgress } from "./analyze";
import { applyBassCorrection } from "./bassCorrection";
import {
  estimateChordFrames,
  type FrameGateMode,
} from "./chordEstimation";
import { estimateKey, estimateTempo } from "./keyTempo";
import { framesToSegments } from "./segmentation";
import { applyUpperBandMode } from "./splitBand";
import { applyConditionalUpperRoot } from "./conditionalBand";
import { applyExtensions } from "./extensionDetection";
import { applyAddTones } from "./addToneDetection";
import { applyUpperLayerReRead } from "./layerChord";
import {
  estimateGenreProfile,
  genreExtensionFactors,
} from "./genreProfile";
import { estimateLocalKeys, type LocalKeyContext } from "./localKey";
import { applyLocalKeyModeNudge } from "./localKeyMode";
import { estimateMeter } from "./meterEstimate";
import {
  applyNoteBassRelabel,
  applyNoteBoundarySnap,
  noteOnsets,
  type NoteEvidenceInput,
} from "./noteEvidence";
import { applyNoteBassRewrite } from "./noteBassRewrite";
import {
  applyNcGapFill,
  applyNcSegmentRematch,
  applyNcStemsFallback,
} from "./ncRecovery";

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
  /**
   * Phase 3 後半（ジャンル傾向の追加チャンネル用）: drums／vocals
   * ステムが渡された場合のみ計算する。コード判定には一切使わず、
   * genreProfile のリズム（ドラム包絡）／メロディ（ボーカル
   * クロマ）／音色（ステム RMS）の材料にだけ使う。
   */
  drumsChroma?: ReturnType<typeof computeChromagram>;
  vocalsChroma?: ReturnType<typeof computeChromagram>;
  stemRms?: { vocals: number; drums: number; bass: number; other: number };
}

function rmsOf(samples: Float32Array): number {
  let acc = 0;
  for (const v of samples) acc += v * v;
  return samples.length > 0 ? Math.sqrt(acc / samples.length) : 0;
}

export function prepareStemChromas(
  mixSamples: Float32Array,
  otherSamples: Float32Array,
  bassSamples: Float32Array,
  sampleRate: number,
  extraStems?: { drums?: Float32Array; vocals?: Float32Array },
): StemChromas {
  const base: StemChromas = {
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
  // ジャンル傾向の追加チャンネル（任意）。drums と vocals が
  // 両方ある場合だけ用意する（音色チャンネルは4ステム前提）。
  // アプリの高精度モード入口は現状この引数を渡さないため、
  // アプリ側では追加チャンネルは欠落として記録される
  // （配線は将来の拡張点として残す）。
  if (extraStems?.drums && extraStems?.vocals) {
    base.drumsChroma = computeChromagram(extraStems.drums, sampleRate);
    base.vocalsChroma = computeChromagram(extraStems.vocals, sampleRate);
    base.stemRms = {
      vocals: rmsOf(extraStems.vocals),
      drums: rmsOf(extraStems.drums),
      bass: rmsOf(bassSamples),
      other: rmsOf(otherSamples),
    };
  }
  return base;
}

export interface StemAnalysisOptions {
  /**
   * Phase 3.1: 二段判定の第2段（拡張音検出）を適用するか。
   * 証拠クロマは other ステムの全帯域クロマ。既定 false
   * （採用判定は measurements/phase3/PHASE3_1_RESULTS.md。
   * 混合音経路の AnalyzeOptions.extensions と同じ扱い）。
   */
  extensions?: boolean;
  /**
   * Phase 3.3: 局所キー文脈の「記録」を有効化するか。true（既定）の
   * 場合、局所キー（other ステムのクロマから推定。全体キー表示の
   * 出所＝混合音とは別に、和声を担う other を使う）を推定して結果の
   * localKeys に格納するだけで、コードラベルには一切触れない。
   * false は記録自体を止めるオプトアウト。消費部（localKey）が
   * 有効な場合は記録も自動的に有効。2026-10-28 の分割採用で
   * 「記録・表示は既定 ON、消費部は既定 OFF」が決まった
   * （混合音経路の AnalyzeOptions.localKeyRecord と同じ扱い）。
   */
  localKeyRecord?: boolean;
  /**
   * Phase 3.3: 局所キー文脈の「消費部」（モード nudge と第2段への
   * 文脈供給）を有効化するか。既定 false（共同採用判定の結果は
   * measurements/phase3/PHASE3_3_RESULTS.md。混合音経路の
   * AnalyzeOptions.localKey と同じ扱い）。
   */
  localKey?: boolean;
  /**
   * Phase 3 後半: ジャンル傾向（genreProfile.ts）の「記録」を
   * 有効化するか。既定は false（明示オプトイン）: true の場合に
   * ジャンル傾向（other ステムの上帯域クロマを証拠に推定。
   * 全体キーは混合音由来の従来値をそのまま使う）を推定して
   * 結果の genreProfile に格納するだけで、コードラベルには
   * 一切触れない。消費部（genre）が有効な場合は記録も自動的に
   * 有効（混合音経路の AnalyzeOptions.genreRecord と同じ扱い。
   * 既定 OFF の経緯はそちらのコメント参照）。
   */
  genreRecord?: boolean;
  /**
   * Phase 3 後半: ジャンル傾向の「消費部」（第2段への曲単位の
   * 係数供給、extensions と併用時）を有効化するか。既定 false
   * （採用は measurements/phase3/PHASE3_GENRE_RESULTS.md の
   * 事前登録基準を見てユーザーが判断する。混合音経路の
   * AnalyzeOptions.genre と同じ扱い）。
   */
  genre?: boolean;
  /**
   * Phase 3 §5: 拍子・小節推定（meterEstimate.ts）の「記録」を
   * 有効化するか。有効な場合、拍子・小節位相・仲裁後テンポの
   * 候補を推定して結果の meterEstimate に加算的に格納する
   * だけで、コードラベルにも結果の bpm にも触れない。
   * オンセット包絡の出所は drums ステムを優先し、無ければ
   * 混合音を使う（SUNO_05 の拍子訂正で drums のアクセント周期が
   * 決め手の一つになったため）。既定は false（明示オプトイン）:
   * 採用判定で事前登録基準 C2 が不合格だったため
   * （PHASE3_METER_RESULTS.md）。消費部（meterArbitrate）が
   * 有効な場合は記録も自動的に有効（混合音経路の
   * AnalyzeOptions.meterRecord と同じ扱い）。
   */
  meterRecord?: boolean;
  /**
   * Phase 3 §5: 拍子・小節推定の「消費部」= BPM 仲裁を有効化
   * するか。有効な場合、勝者のテンポスケールを結果の bpm に
   * 反映する。コードラベルは変えない。既定は false: 採用判定で
   * 仲裁の基準（C3–C5）が合格しなかったため
   * （PHASE3_METER_RESULTS.md。混合音経路の
   * AnalyzeOptions.meterArbitrate と同じ扱い）。
   */
  meterArbitrate?: boolean;
  /**
   * N.C. 回復 1: セグメント再照合（ncRecovery.ts）を有効化するか。
   * N.C. 区間の other 集計クロマを、混合音クロマの集計とルートが
   * 一致する場合に限り再判定して充填する。強いベース証拠が候補の
   * 構成音と矛盾する場合は充填しない。充填ラベルには
   * ncFill: "segment-rematch" と低く抑えた信頼度が付く。
   * 既定は false（明示オプトイン。混合音経路の
   * AnalyzeOptions.ncSegmentRematch と同じ扱い）。
   */
  ncSegmentRematch?: boolean;
  /**
   * N.C. 回復 2: ステム副次証拠フォールバック（ncRecovery.ts）を
   * 有効化するか。other ステムの証拠が薄い（ゲート率 >= 50%）
   * N.C. 区間を、混合音の集計＋フレーム最頻が明瞭で、強いベース
   * 証拠と矛盾しない場合に混合音側の読みで充填する
   * （ncFill: "stems-fallback"）。既定は false。
   */
  ncStemsFallback?: boolean;
  /**
   * N.C. 回復 3: 短い欠落の充填（ncRecovery.ts）を有効化するか。
   * 両隣が同一コードの短い（<= 1.0 秒）N.C. だけをそのコードで
   * 充填する（ncFill: "gap-fill"）。既定は false
   * （混合音経路の AnalyzeOptions.ncGapFill と同じ扱い）。
   */
  ncGapFill?: boolean;
  /**
   * フレーム無音ゲートの方式（chordEstimation.ts の FrameGateMode）。
   * 既定は "song-referenced"（曲参照ゲート）: フレームが落ちるのは
   * 「other が相対的に静か」かつ「混合音もその瞬間は静か」な
   * ときだけになる（参照 = 混合音のエネルギー列）。
   * measurements/nc/FRAME_GATE.md §3 の事前登録基準による採用判定を
   * 経て既定化した。"legacy" は旧方式の明示オプトアウト: other
   * ステム自身のエネルギー中央値比だけで落とすため、静かな和声
   * 区間が区間ごと N.C. になる（NC_ANALYSIS.md §3 の診断対象。
   * 履歴測定の再現用に残す。混合音経路の AnalyzeOptions.frameGate
   * と同じ扱い）。
   */
  frameGate?: FrameGateMode;
  /**
   * 曲参照ゲートの救済フロア比率（FRAME_GATE.md §2 のフロンティア
   * 測定用）。既定 0 = 絶対下限のみ（原則点）。
   */
  frameGateRescueFloorRatio?: number;
  /**
   * 音符レベル統合の入力（noteEvidence.ts）: 音高検出で得た音符
   * イベント列。ステム経路では harmony に other ステムの音符列、
   * bass に bass ステムの音符列を渡す。抽出手段には依存しない。
   * 未指定の場合、note* フラグが ON でも各統合は無動作になる
   * （混合音経路の AnalyzeOptions.noteEvidence と同じ扱い）。
   */
  noteEvidence?: NoteEvidenceInput;
  /**
   * 音符レベル統合1: 音符証拠による bassPc の確定／付け替え
   * （noteEvidence.ts の applyNoteBassRelabel。コードは変更
   * しない。v2 で書き換えから分離）。既定は true（2026-10-29
   * 採用、明示 false のときだけ無効）。採用根拠は
   * NOTEPITCH_INTEGRATION.md および NOTEPITCH_RETRY.md
   * （混合音経路の AnalyzeOptions.noteBass と同じ扱い）。
   */
  noteBass?: boolean;
  /**
   * 音符レベル統合1b: 厳格化したコード書き換え（修復・昇格、
   * noteBassRewrite.ts）。音符証拠とクロマ適合の二重証拠が
   * 揃う場合のみ発火する。stems 経路でのみ有効（混合音では
   * 書き換え禁止）。noteBass と独立に ON/OFF できる。
   * 既定は false。
   */
  noteBassRewrite?: boolean;
  /**
   * 音符レベル統合2: テンションの独立証人。extensions 有効時に、
   * 第2段の 7 度音シェア証拠を other ステムの音符の実在証拠で
   * 扱う。既定は false（明示オプトイン）。noteEvidence が必要。
   */
  noteTension?: boolean;
  /**
   * 音符証人の使い方（測定用）。既定 "replace"、"bonus" は比較用。
   * "veto" は密度＋二重確認が揃う窓でのみ不在を棄却（v2 主形）、
   * "gated" は差し替えを発言権のある窓に限定（v2 比較形）。
   */
  noteTensionMode?: "replace" | "bonus" | "gated" | "veto";
  /**
   * 音符レベル統合3: セグメンテーション境界の音符オンセットへの
   * 近傍スナップ。境界決定そのものは変えず、framesToSegments の
   * 直後に補正として働く。既定は false（明示オプトイン）。
   * noteEvidence が必要。
   */
  noteBoundaries?: boolean;
}

/** 計算済みクロマから、指定した帯域戦略でステム解析を行う */
export function analyzeStemsWithStrategy(
  chromas: StemChromas,
  sampleRate: number,
  fileName: string,
  strategy: StemBandStrategy,
  opts?: StemAnalysisOptions,
): AnalysisResult {
  const started = performance.now();
  const { mixChroma, otherChroma, bassChroma, duration } = chromas;
  const fd = otherChroma.frameDuration;
  // s-unified だけフレーム判定も上帯域クロマ。それ以外は全帯域
  const frameChroma =
    strategy === "s-unified" ? otherChroma.chordFrames : otherChroma.frames;
  const frames = estimateChordFrames(frameChroma, otherChroma.energies, fd, {
    mode: opts?.frameGate ?? "song-referenced",
    // 曲参照ゲートの参照は混合音のエネルギー列（FRAME_GATE.md §2）
    referenceEnergies: mixChroma.energies,
    rescueFloorRatio: opts?.frameGateRescueFloorRatio,
  });
  const key = estimateKey(mixChroma.frames);
  const bpm = estimateTempo(mixChroma.onsetEnvelope, mixChroma.frameDuration);

  let segments = framesToSegments(frames, fd, duration);
  // 音符レベル統合3: 境界補正（明示オプトイン、既定 OFF）。
  // オンセットの出所は other＋bass の音符列。境界決定そのものは
  // 変えず、後段すべての集計に効くよう最上流に置く
  // （混合音経路の AnalyzeOptions.noteBoundaries と同じ扱い）。
  if (opts?.noteBoundaries && opts?.noteEvidence) {
    segments = applyNoteBoundarySnap(
      segments,
      noteOnsets([
        ...opts.noteEvidence.harmony,
        ...(opts.noteEvidence.bass ?? []),
      ]),
    );
  }
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
  // 音符レベル統合1: bassPc の確定／付け替え（既定 ON、2026-10-29
  // 採用。v2 で書き換えから分離した基本形で、コードは変更しない。
  // 明示 false のときだけ無効）。ベース補正・条件分岐・モード
  // 決め直しの後に、bass ステムの音符証拠で bassPc を置換・補強
  // する。層の再読と第2段より前に置く（混合音経路と同じ位置づけ）。
  // noteEvidence が無い場合は無動作で、従来と完全一致する。
  if (opts?.noteBass !== false && opts?.noteEvidence) {
    segments = applyNoteBassRelabel(segments, opts.noteEvidence);
  }
  // 音符レベル統合1b: 厳格化した書き換え（サブオプション）。
  // 付け替えの直後に、音符証拠とクロマ適合の二重証拠が揃う
  // 場合のみ修復・昇格を許可する。二重証拠のクロマは、層の
  // 再読が使う other 全帯域クロマと同じもの（証拠系統を増やさ
  // ず、独立性の担保は「音符側シェア」と「エネルギー加重クロマ
  // 集計」の系統差に置く）。stems 経路でのみ呼ばれる。
  if (opts?.noteBassRewrite && opts?.noteEvidence) {
    segments = applyNoteBassRewrite(segments, opts.noteEvidence, {
      frames: otherChroma.frames,
      energies: otherChroma.energies,
      frameDuration: fd,
    });
  }
  // Phase 3.3: 局所キー文脈。局所キーの出所は other ステムの全帯域
  // クロマにする（全体キー表示は従来どおり混合音由来で変えない）。
  // 混合音から推定すると、実曲1のようにボーカル等の影響で平行短調へ
  // 倒れたキー（A major の曲を A minor と誤る）がそのまま prior に
  // なり誤反転を量産したため、和声そのものを担う other を出所とする
  // （実測根拠は PHASE3_3_RESULTS.md: other 由来では同曲の窓は
  // A major に戻る）。証拠クロマはモード決め直しと同じ other 上帯域。
  // 「記録」は既定で有効（localKeyRecord。結果への格納のみでラベルに
  // 触れない）。「消費」（モード nudge＋第2段への文脈供給）は既定
  // OFF の明示オプション（localKey）のときだけ効かせる（分割採用、
  // 2026-10-28）。
  const consumeLocalKey = opts?.localKey === true;
  const recordLocalKey = consumeLocalKey || opts?.localKeyRecord !== false;
  let localKeyCtx: LocalKeyContext | undefined;
  if (recordLocalKey) {
    localKeyCtx = estimateLocalKeys(
      otherChroma.frames,
      otherChroma.energies,
      otherChroma.frameDuration,
      duration,
    );
    if (consumeLocalKey) {
      segments = applyLocalKeyModeNudge(
        segments,
        otherChroma.chordFrames,
        otherChroma.energies,
        fd,
        localKeyCtx,
      );
    }
  }
  // Phase 3.2: 分数コードの上層の再読（層表示用）。潰れたセグメント
  // （upperChord を持つもの）だけが対象で、証拠は other ステムの
  // 全帯域クロマ（ベース音を除いたセグメント集計）。分離後の
  // other の低域は実在の情報であり、混合音経路（上帯域を使う）と
  // 証拠帯域が異なるのは帯域事情の違いによる（layerChord.ts の
  // 冒頭コメント参照）。upperChord / upperExtension のみを触り、
  // 既定ラベルは変えない。
  segments = applyUpperLayerReRead(
    segments,
    otherChroma.frames,
    otherChroma.energies,
    fd,
  );

  // Phase 3 後半: ジャンル傾向の推定。第1段の確定セグメント列と
  // 全体キー（混合音由来）、other ステムの上帯域クロマの証拠から
  // 曲単位のスタイル分布を推定する。「記録」は明示オプトイン
  // （genreRecord: true。既定 OFF。結果への格納のみでラベルに
  // 触れない）。「消費」（第2段への係数供給）は既定 OFF の明示
  // オプション（genre）のときだけ効かせる（その場合、記録も
  // 自動で有効になる。混合音経路と同じ規律）。
  const consumeGenre = opts?.genre === true;
  const recordGenre = consumeGenre || opts?.genreRecord === true;
  let genreCtx: GenreProfile | undefined;
  if (recordGenre) {
    // 追加チャンネル: リズムはドラムステムの包絡を優先（無ければ
    // 混合音）、メロディはボーカルクロマ、音色はステム RMS。
    // 用意されていないチャンネルは欠落として記録される。
    const rhythmChroma = chromas.drumsChroma ?? mixChroma;
    genreCtx = estimateGenreProfile(
      segments,
      otherChroma.chordFrames,
      otherChroma.energies,
      fd,
      key.root,
      key.mode,
      duration,
      {
        onsetEnvelope: rhythmChroma.onsetEnvelope,
        onsetFrameDuration: rhythmChroma.frameDuration,
        ...(chromas.vocalsChroma
          ? {
              melodyChroma: {
                frames: chromas.vocalsChroma.frames,
                energies: chromas.vocalsChroma.energies,
                frameDuration: chromas.vocalsChroma.frameDuration,
              },
            }
          : {}),
        ...(chromas.stemRms ? { stemRms: chromas.stemRms } : {}),
      },
    );
  }

  // Phase 3 §5: 拍子・小節推定。第1段の確定セグメント境界と
  // オンセット包絡、検出 BPM（混合音由来）から候補を裁定する。
  // 包絡の出所は drums ステムを優先する（ジャンル傾向のリズム
  // チャンネルと同じ選択。SUNO_05 の拍子訂正で drums の
  // アクセント周期が決め手の一つになった）。「記録」は明示
  // オプトイン（meterRecord。採用判定で既定 ON にしなかった:
  // PHASE3_METER_RESULTS.md。結果への格納のみでラベルにも
  // bpm にも触れない）。「消費」（BPM 仲裁）は meterArbitrate
  // のときだけ。
  const consumeMeter = opts?.meterArbitrate === true;
  const recordMeter = consumeMeter || opts?.meterRecord === true;
  let meterCtx: MeterEstimate | undefined;
  if (recordMeter) {
    const rhythmChroma = chromas.drumsChroma ?? mixChroma;
    meterCtx =
      estimateMeter({
        onsetEnvelope: rhythmChroma.onsetEnvelope,
        frameDuration: rhythmChroma.frameDuration,
        segments,
        detectedBpm: bpm,
        durationSec: duration,
        onsetSource: chromas.drumsChroma ? "drums" : "mixture",
      }) ?? undefined;
  }
  const finalBpm =
    consumeMeter && meterCtx?.tempoBpm != null ? meterCtx.tempoBpm : bpm;

  // N.C. 回復（明示オプトイン、既定 OFF。ncRecovery.ts）。
  // 局所キー／ジャンル／拍子の推定が見るセグメント列は回復前の
  // 第1段の確定列のままにするため、それらの後段・第2段の直前に置く。
  // 判定経路のクロマはフレーム判定に使われたもの（frameChroma）と同一。
  if (opts?.ncSegmentRematch) {
    segments = applyNcSegmentRematch(segments, {
      judgeFrames: frameChroma,
      judgeEnergies: otherChroma.energies,
      secondFrames: mixChroma.frames,
      secondEnergies: mixChroma.energies,
      frameDuration: fd,
      modeFrames: strategy === "s-unified" ? null : otherChroma.chordFrames,
      bassFrames: bassChroma.bassFrames,
    });
  }
  if (opts?.ncStemsFallback) {
    segments = applyNcStemsFallback(segments, {
      judgeEnergies: otherChroma.energies,
      mixFrames: mixChroma.frames,
      mixEnergies: mixChroma.energies,
      bassFrames: bassChroma.bassFrames,
      frameDuration: fd,
    });
  }
  if (opts?.ncGapFill) {
    segments = applyNcGapFill(segments, frameChroma, otherChroma.energies, fd);
  }

  // Phase 3.1: 二段判定の第2段（拡張音検出、既定 OFF）。
  // 証拠は other ステムの上帯域クロマ（extensionDetection.ts 冒頭参照）。
  // 文脈 prior は消費部（opts.localKey）が有効な場合にだけ渡す。
  // Phase 3.2 の付加音（add9）検出も同じオプトインの中で直後に行う。
  if (opts?.extensions) {
    segments = applyExtensions(
      segments,
      otherChroma.chordFrames,
      otherChroma.energies,
      fd,
      {
        keyRoot: key.root,
        keyMode: key.mode,
        ...(consumeLocalKey && localKeyCtx
          ? { localKeys: localKeyCtx, contextPrior: true }
          : {}),
        ...(consumeGenre && genreCtx
          ? { genreFactors: genreExtensionFactors(genreCtx) }
          : {}),
        // 音符レベル統合2: テンションの独立証人（明示オプトイン）
        ...(opts?.noteTension && opts?.noteEvidence
          ? {
              noteEvidence: opts.noteEvidence,
              noteWitnessMode: opts?.noteTensionMode ?? "replace",
            }
          : {}),
      },
    );
    segments = applyAddTones(
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
    bpm: finalBpm,
    segments,
    analyzedInMs: Math.round(performance.now() - started),
    ...(localKeyCtx ? { localKeys: localKeyCtx.windows } : {}),
    ...(genreCtx ? { genreProfile: genreCtx } : {}),
    ...(meterCtx ? { meterEstimate: meterCtx } : {}),
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
  /** モデル取得の記録（実測がある場合）。結果へそのまま引き継ぐ */
  modelFetch?: ModelFetchSummary;
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
    ...(input.modelFetch ? { modelFetch: input.modelFetch } : {}),
  };
}

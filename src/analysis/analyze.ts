import { computeChromagram, type ChromaBandOptions } from "../dsp/chroma";
import { applyBassCorrection } from "./bassCorrection";
import { applyConditionalUpperRoot } from "./conditionalBand";
import {
  estimateChordFrames,
  type FrameGateMode,
} from "./chordEstimation";
import { applyExtensions } from "./extensionDetection";
import { applyAddTones } from "./addToneDetection";
import { applyUpperLayerReRead } from "./layerChord";
import {
  estimateGenreProfile,
  genreExtensionFactors,
} from "./genreProfile";
import { estimateKey, estimateTempo } from "./keyTempo";
import { estimateLocalKeys, type LocalKeyContext } from "./localKey";
import { estimateMeter } from "./meterEstimate";
import {
  applyNoteBassRelabel,
  applyNoteBoundarySnap,
  noteOnsets,
  type NoteEvidenceInput,
} from "./noteEvidence";
import { applyNcGapFill, applyNcSegmentRematch } from "./ncRecovery";
import { applyLocalKeyModeNudge } from "./localKeyMode";
import { framesToSegments } from "./segmentation";
import { applyUpperBandMode } from "./splitBand";
import type { AnalysisResult, GenreProfile, MeterEstimate } from "../types";

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
  /**
   * Phase 3.1: 二段判定の第2段（拡張音検出、extensionDetection.ts）を
   * 適用するか。true の場合、全ての後段処理が終わったセグメントに
   * 対して maj7 / 7 / m7 の証拠判定を行い、ChordSegment.extension を
   * 付ける（コアの chord 文字列は原則そのまま。再解釈が発火した
   * セグメントだけルートが変わる）。
   * 既定は false（2026-10-28 時点）。Phase 3.1 の採用判定
   * （measurements/phase3/PHASE3_1_RESULTS.md）で合格基準の一部
   * （Suno Q2 の否定テスト）が第1段由来で未達だったため、既定化は
   * ユーザーの再判断待ちとし、明示指定時のみ有効になる。
   */
  extensions?: boolean;
  /**
   * Phase 3.3: 局所キー文脈（localKey.ts）の「記録」を有効化するか。
   * true（既定）の場合、局所キーを推定して結果の localKeys（窓列）に
   * 加算的に格納するだけで、コードラベルには一切触れない。
   * false は記録自体を止めるオプトアウト（履歴測定の固定やテスト用）。
   * 消費部（localKey オプション）が有効な場合は記録も自動的に有効。
   * 2026-10-28 の分割採用（ユーザー判断、PHASE3_PLAN.md §6 追記）で
   * 「記録・表示は既定 ON、消費部は既定 OFF」が決まった。
   */
  localKeyRecord?: boolean;
  /**
   * Phase 3.3: 局所キー文脈の「消費部」を有効化するか:
   * - 第1段のモード決定への柔らかい prior（localKeyMode.ts の
   *   nudge。接戦のモードだけを局所キーの尤もらしさで nudging する）
   * - 第2段への文脈供給（局所キーによるダイアトニック緩和の
   *   差し替えと、maj7 の背景シェア割り引き。extensions と併用時）
   * 既定は false。Phase 3.3 との共同採用判定（2026-10-28、
   * measurements/phase3/PHASE3_3_RESULTS.md）で Q2 基準は合格
   * したが、基準3（実曲の三和音スコア）と曲3完全ラベルの回復が
   * 合格水準に届かず、既定 OFF を維持する。記録だけの有効化は
   * localKeyRecord（既定 true）が担う。
   */
  localKey?: boolean;
  /**
   * Phase 3 後半: ジャンル傾向（genreProfile.ts）の「記録」を
   * 有効化するか。既定は false（明示オプトイン）: true の場合に
   * ジャンル傾向を推定して結果の genreProfile に相加的に格納
   * するだけで、コードラベルには一切触れない。消費部（genre
   * オプション）が有効な場合は記録も自動的に有効。当初は記録
   * 既定 ON＋消費 OFF の分割採用を提案したが、推定の考察要素を
   * 検討し直す（v2）ことを優先するユーザー判断（2026-10-28）
   * で分割採用は取らず、記録も既定 OFF として公開する。拍子
   * （meterRecord）と同じ「記録も消費も明示オプトイン」の形。
   */
  genreRecord?: boolean;
  /**
   * Phase 3 後半: ジャンル傾向の「消費部」を有効化するか:
   * 第2段（extensions と併用時）に、スタイル分布から導いた
   * 曲単位の係数を拡張クラスごとのシェアしきい値への柔らかい
   * prior として渡す。既定は false。採用は測定
   * （measurements/phase3/PHASE3_GENRE_RESULTS.md の事前登録
   * 基準）を見てユーザーが判断する。
   */
  genre?: boolean;
  /**
   * Phase 3 §5: 拍子・小節推定（meterEstimate.ts）の「記録」を
   * 有効化するか。有効な場合、拍子・小節位相・仲裁後テンポの
   * 候補を推定して結果の meterEstimate に加算的に格納する
   * だけで、コードラベルにも結果の bpm にも触れない。
   * 既定は false（明示オプトイン）: 採用判定（PHASE3_METER_
   * RESULTS.md）で事前登録基準 C2（実曲の陰性ケース）が
   * 不合格だったため、記録・表示とも既定 ON にはしなかった。
   * 消費部（meterArbitrate）が有効な場合は記録も自動的に有効。
   * 局所キー・ジャンル傾向と同じ記録／消費の分離。
   */
  meterRecord?: boolean;
  /**
   * Phase 3 §5: 拍子・小節推定の「消費部」= BPM 仲裁を有効化
   * するか。有効な場合、勝者のテンポスケール（倍取り・3:2 の
   * 裁定結果）を結果の bpm に反映する。コードラベルは変えない
   * （§5 の非目標）。検出 BPM の生値は meterEstimate.detectedBpm
   * に残る。既定は false: 採用判定で仲裁の基準（C3–C5）が
   * 合格しなかったため（PHASE3_METER_RESULTS.md）。
   */
  meterArbitrate?: boolean;
  /**
   * N.C. 回復 1: セグメント再照合（ncRecovery.ts）を有効化するか。
   * N.C. 区間の集計クロマを、第2の視点（上帯域クロマ）の集計と
   * ルートが一致する場合に限り再判定して充填する。充填ラベルには
   * ncFill: "segment-rematch" と低く抑えた信頼度が付く。
   * 既定は false（明示オプトイン）。採用判定は
   * measurements/nc/NC_ANALYSIS.md の事前登録基準で行う。
   */
  ncSegmentRematch?: boolean;
  /**
   * N.C. 回復 3: 短い欠落の充填（ncRecovery.ts）を有効化するか。
   * 両隣が同一コードの短い（<= 1.0 秒）N.C. だけをそのコードで
   * 充填する（ncFill: "gap-fill"）。既定は false。
   */
  ncGapFill?: boolean;
  /**
   * フレーム無音ゲートの方式（chordEstimation.ts の FrameGateMode）。
   * 既定は "song-referenced"（曲参照ゲート）: フレームが落ちる条件に
   * 「混合音もその瞬間 静かであること」を追加する再設計で、
   * measurements/nc/FRAME_GATE.md §3 の事前登録基準による採用判定を
   * 経て既定化した。"legacy" は旧方式の明示オプトアウト
   * （履歴測定の再現用）。混合音経路では参照エネルギー ≡ 判定
   * エネルギーになるため、どちらの方式でも出力はビット一致する
   * （帰着）。
   */
  frameGate?: FrameGateMode;
  /**
   * 曲参照ゲートの救済フロア比率（FRAME_GATE.md §2 のフロンティア
   * 測定用）。既定 0 = 絶対下限のみ（原則点）。
   */
  frameGateRescueFloorRatio?: number;
  /**
   * 音符レベル統合の入力（noteEvidence.ts）: 音高検出で得た音符
   * イベント列。混合音経路では harmony に混合音の音符列を渡す。
   * 抽出手段には依存しない（ハーネス測定では検証時の音符キャッシュ、
   * 製品では将来のブラウザ推論）。未指定の場合、note* フラグが
   * ON でも各統合は無動作になる。
   */
  noteEvidence?: NoteEvidenceInput;
  /**
   * 音符レベル統合1: 音符証拠による bassPc の確定／付け替え
   * （noteEvidence.ts の applyNoteBassRelabel。コードは変更しない。
   * v2 で書き換えから分離した基本形）。既定は true（2026-10-29
   * 採用、明示 false のときだけ無効）。採用根拠は
   * measurements/notepitch/NOTEPITCH_RETRY.md（登録基準を全て
   * 満たし、回帰ゼロ）。noteEvidence が必要で、未指定の場合は
   * 従来と完全一致する（音符入力なしでは無動作）。
   */
  noteBass?: boolean;
  /**
   * 音符レベル統合1b: 厳格化したコード書き換え（修復・昇格、
   * noteBassRewrite.ts）。音符証拠とクロマ適合の二重証拠が揃う
   * 場合のみ発火する。stems 経路（analyzeStems）でのみ作用し、
   * 本経路（混合音）では指定されても無効（書き換え禁止）。
   * noteBass と独立に ON/OFF できる。既定は false。
   */
  noteBassRewrite?: boolean;
  /**
   * 音符レベル統合2: テンションの独立証人。extensions 有効時に、
   * 第2段の 7 度音シェア証拠を音符の実在証拠で扱う
   * （extensionDetection.ts の noteWitness）。既定は false
   * （明示オプトイン）。noteEvidence が必要で、extensions が
   * 無効な場合は意味を持たない。
   */
  noteTension?: boolean;
  /**
   * 音符証人の使い方（測定用）。既定は "replace"（7 度音シェアの
   * 差し替え）。"bonus" は実在証人が強い場合の加算型（比較用）。
   * "veto" は密度＋二重確認が揃う窓でのみ不在を棄却（v2 主形）、
   * "gated" は差し替えを発言権のある窓に限定（v2 比較形）。
   */
  noteTensionMode?: "replace" | "bonus" | "gated" | "veto";
  /**
   * 音符レベル統合3: セグメンテーション境界の音符オンセットへの
   * 近傍スナップ（noteEvidence.ts の applyNoteBoundarySnap）。
   * 境界決定そのものは変えず、framesToSegments の直後に補正として
   * 働く。既定は false（明示オプトイン）。noteEvidence が必要。
   */
  noteBoundaries?: boolean;
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
    {
      mode: options?.frameGate ?? "song-referenced",
      // 混合音経路では参照 = 判定経路そのもの（曲参照ゲートは
      // 現行規則に帰着する。FRAME_GATE.md §2）
      referenceEnergies: chroma.energies,
      rescueFloorRatio: options?.frameGateRescueFloorRatio,
    },
  );

  onProgress?.({ stage: "キーとテンポを推定中…", ratio: 0.8 });
  await yieldToUi();
  const key = estimateKey(chroma.frames);
  const bpm = estimateTempo(chroma.onsetEnvelope, chroma.frameDuration);

  onProgress?.({ stage: "セグメントを整形中…", ratio: 0.9 });
  await yieldToUi();
  const duration = monoSamples.length / sampleRate;
  let phase0Segments = framesToSegments(frames, chroma.frameDuration, duration);

  // 音符レベル統合3: 境界補正（明示オプトイン、既定 OFF）。
  // 境界汚染は後段すべての集計に効くため、補正として最も上流
  // （framesToSegments の直後）に置く。境界決定そのものは変えない。
  if (options?.noteBoundaries && options?.noteEvidence) {
    phase0Segments = applyNoteBoundarySnap(
      phase0Segments,
      noteOnsets([
        ...options.noteEvidence.harmony,
        ...(options.noteEvidence.bass ?? []),
      ]),
    );
  }

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

  // 音符レベル統合1: bassPc の確定／付け替え（既定 ON、2026-10-29
  // 採用。v2 で書き換えから分離した基本形で、コードは変更しない。
  // 明示 false のときだけ無効）。ベース補正・条件分岐・モード
  // 決め直しが終わったセグメント列に対して、音符ベース証拠で
  // bassPc を置換・補強する。層の再読（Phase 3.2）と第2段
  // （bassPc を参照する再解釈ゲート）より前に置く。書き換え
  // （noteBassRewrite）は stems 経路でのみ有効で、本経路では
  // 指定されても無効。noteEvidence が無い場合は無動作で、
  // 従来と完全一致する。
  if (options?.noteBass !== false && options?.noteEvidence) {
    onProgress?.({ stage: "音符証拠でベースを確定中…", ratio: 0.972 });
    await yieldToUi();
    segments = applyNoteBassRelabel(segments, options.noteEvidence);
  }

  // Phase 3.3: 局所キー文脈の推定。全帯域クロマ（全体キーと同じ出所）
  // から窓ごとのキー候補を推定する。「記録」は既定で有効
  // （localKeyRecord）で、結果の localKeys に格納するだけであり、
  // ラベルには触れない。「消費」（モード nudge）は既定 OFF の
  // 明示オプション（localKey）のときだけ、モード決め直しの後に
  // 柔らかい prior として効かせる（分割採用、2026-10-28）。
  const consumeLocalKey = options?.localKey === true;
  const recordLocalKey = consumeLocalKey || options?.localKeyRecord !== false;
  let localKeyCtx: LocalKeyContext | undefined;
  if (recordLocalKey) {
    onProgress?.({ stage: "局所キーを推定中…", ratio: 0.975 });
    await yieldToUi();
    localKeyCtx = estimateLocalKeys(
      chroma.frames,
      chroma.energies,
      chroma.frameDuration,
      duration,
    );
    if (consumeLocalKey) {
      segments = applyLocalKeyModeNudge(
        segments,
        chroma.chordFrames,
        chroma.energies,
        chroma.frameDuration,
        localKeyCtx,
      );
    }
  }

  // Phase 3.2: 分数コードの上層の再読（層表示用）。ベース補正で
  // 潰れたセグメント（upperChord を持つもの）だけを対象に、層の
  // 実在を判定し、上層をセグメント集計（ベース音を除く）で再読する。
  // 証拠は上帯域クロマ（chordFrames）: 混合音の全帯域は低域の
  // ビン分解能不足でベース基音が ±1 半音へ滲み、適合度が歪むため
  // （layerChord.ts の冒頭コメント参照）。触るのは upperChord /
  // upperExtension のみで、chord / extension / bassPc は変えない
  // ため、既定ラベルは従来と完全一致する。
  onProgress?.({ stage: "分数コードの層を整理中…", ratio: 0.978 });
  await yieldToUi();
  segments = applyUpperLayerReRead(
    segments,
    chroma.chordFrames,
    chroma.energies,
    chroma.frameDuration,
  );

  // Phase 3 後半: ジャンル傾向の推定。第1段の確定セグメント列
  // （第2段がこれから見る列そのもの）と全体キー、上帯域クロマの
  // 証拠から、曲単位のスタイル分布を推定する。「記録」は明示
  // オプトイン（genreRecord: true。既定 OFF）で、有効な場合に
  // 結果の genreProfile に格納するだけで、ラベルには触れない。
  // 「消費」（第2段への係数供給）は既定 OFF の明示オプション
  // （genre）のときだけ、拡張音検出の文脈に渡す（記録も自動で
  // 有効になる）。記録だけのプロファイルは判定に使わない。
  const consumeGenre = options?.genre === true;
  const recordGenre = consumeGenre || options?.genreRecord === true;
  let genreCtx: GenreProfile | undefined;
  if (recordGenre) {
    onProgress?.({ stage: "ジャンル傾向を推定中…", ratio: 0.979 });
    await yieldToUi();
    genreCtx = estimateGenreProfile(
      segments,
      chroma.chordFrames,
      chroma.energies,
      chroma.frameDuration,
      key.root,
      key.mode,
      duration,
      // 混合音経路で実在するチャンネルはリズム（混合音の
      // オンセット包絡）のみ。メロディ／音色は分離されていない
      // ため欠落として扱う（genreProfile.ts の冒頭コメント参照）
      {
        onsetEnvelope: chroma.onsetEnvelope,
        onsetFrameDuration: chroma.frameDuration,
      },
    );
  }

  // Phase 3 §5: 拍子・小節推定。第1段の確定セグメント境界と
  // オンセット包絡、検出 BPM から「テンポスケール × 拍子」の
  // 候補を裁定する。「記録」は明示オプトイン（meterRecord。
  // 採用判定で既定 ON にしなかった: PHASE3_METER_RESULTS.md）で、
  // 結果の meterEstimate に格納するだけであり、ラベルにも
  // bpm にも触れない。「消費」（BPM 仲裁）は meterArbitrate の
  // ときだけ、勝者のスケールを bpm に反映する。ジャンル傾向と
  // 同じく、推定は第2段が見るのと同じ第1段の確定列に対して行う。
  const consumeMeter = options?.meterArbitrate === true;
  const recordMeter = consumeMeter || options?.meterRecord === true;
  let meterCtx: MeterEstimate | undefined;
  if (recordMeter) {
    onProgress?.({ stage: "拍子を推定中…", ratio: 0.9795 });
    await yieldToUi();
    meterCtx =
      estimateMeter({
        onsetEnvelope: chroma.onsetEnvelope,
        frameDuration: chroma.frameDuration,
        segments,
        detectedBpm: bpm,
        durationSec: duration,
        onsetSource: "mixture",
      }) ?? undefined;
  }
  const finalBpm =
    consumeMeter && meterCtx?.tempoBpm != null ? meterCtx.tempoBpm : bpm;

  // N.C. 回復（明示オプトイン、既定 OFF。ncRecovery.ts）。
  // 局所キー／ジャンル／拍子の推定が見るセグメント列は回復前の
  // 第1段の確定列のままにするため、それらの後段・第2段の直前に置く。
  // 判定経路のクロマはフレーム判定に使われたもの（split なら全帯域、
  // unified なら上帯域）と同一にする。
  const judgeFrames = splitMode ? chroma.frames : chroma.chordFrames;
  if (options?.ncSegmentRematch) {
    onProgress?.({ stage: "無判定区間を再照合中…", ratio: 0.9797 });
    await yieldToUi();
    segments = applyNcSegmentRematch(segments, {
      judgeFrames,
      judgeEnergies: chroma.energies,
      secondFrames: chroma.chordFrames,
      secondEnergies: chroma.energies,
      frameDuration: chroma.frameDuration,
      modeFrames: splitMode ? chroma.chordFrames : null,
      bassFrames: null,
    });
  }
  if (options?.ncGapFill) {
    segments = applyNcGapFill(
      segments,
      judgeFrames,
      chroma.energies,
      chroma.frameDuration,
    );
  }

  // Phase 3.1: 二段判定の第2段（拡張音検出）。全ての後段処理の後に、
  // 上帯域クロマを証拠としてセグメント単位で 7th を判定する
  // （証拠帯域の根拠は extensionDetection.ts の冒頭コメント）。
  // 既定 OFF（options.extensions のコメント参照）。文脈 prior
  // （局所キー＋背景シェア割り引き）は、消費部（options.localKey）
  // が有効な場合にだけ渡す。記録だけの局所キー（既定で算出される）
  // は第2段の判定には使わない（分割採用、2026-10-28）。
  // Phase 3.2 の付加音（add9）検出も同じオプトインの中で、
  // 第2段の直後に行う（addToneDetection.ts）。
  if (options?.extensions) {
    onProgress?.({ stage: "7th（拡張音）を検出中…", ratio: 0.98 });
    await yieldToUi();
    segments = applyExtensions(
      segments,
      chroma.chordFrames,
      chroma.energies,
      chroma.frameDuration,
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
        ...(options?.noteTension && options?.noteEvidence
          ? {
              noteEvidence: options.noteEvidence,
              noteWitnessMode: options?.noteTensionMode ?? "replace",
            }
          : {}),
      },
    );
    segments = applyAddTones(
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
    bpm: finalBpm,
    segments,
    analyzedInMs: Math.round(performance.now() - started),
    ...(localKeyCtx ? { localKeys: localKeyCtx.windows } : {}),
    ...(genreCtx ? { genreProfile: genreCtx } : {}),
    ...(meterCtx ? { meterEstimate: meterCtx } : {}),
  };
}

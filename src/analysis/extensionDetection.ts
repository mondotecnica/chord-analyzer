import { chordName } from "../lib/notes";
import type { ChordExtension, ChordSegment } from "../types";
import { parseChordName } from "./bassCorrection";
import { localKeyWindowAt, type LocalKeyContext } from "./localKey";
import {
  noteSegmentWitness,
  type NoteEvidenceInput,
  type NoteWitness,
} from "./noteEvidence";

/**
 * Phase 3.1: 7th／テンションの二段判定 — 第2段（拡張音検出）。
 * 計画: PHASE3_PLAN.md §3.1、設計規則: DESIGN_NOTES.md。
 *
 * 役割分担:
 * - 第1段（既存パイプライン: フレーム判定→ベース補正→条件分岐→
 *   モード決め直し）は三和音コア（ルート＋major/minor）を確定する。
 *   本モジュールは第1段の結果を一切変更しない（例外は下記の
 *   「7th ハイジャック再解釈」1 件のみで、これも第1段の出力を
 *   入力として検証する第2段の仮説である）。
 * - 第2段（本モジュール）は、確定したセグメントごとに「三和音では
 *   説明できない残りの音」から 7th を検出する。テンプレートを
 *   全コード×全クオリティに増やす方式は採らない。評価する仮説は
 *   セグメントあたり最大で次の 3 つだけ:
 *     (a) 検出ルートのままの maj7（major のみ）
 *     (b) 検出ルートのままの dom7（major のみ）／m7（minor のみ）
 *     (c) 7th ハイジャック再解釈: 検出ルートが「全音上の dom7 の
 *         7 度音」だったという仮説（例: A と読まれた音集合が実は B7）。
 *         ベース証拠（bassPc）が再解釈先ルートと一致する場合に限る。
 *         Suno 05 Q3 の B7→「A」誤読（SUNO_05_ANALYSIS.md 照合済み）が
 *         この型であり、PHASE3_PLAN.md §2 の実例で「B7 候補の尤度が
 *         上がれば防げる」とされた機構そのもの。
 * - 初期語彙は maj7 / dom7(7) / m7 の 3 種のみ（計画 §3.1）。
 *   9th／add9／sus は 3.2 以降の範囲で、ここでは扱わない。
 * - キー文脈は「柔らかい prior」としてのみ使う（DESIGN_NOTES の
 *   確定規則）: ダイアトニックな候補はシェアしきい値を僅かに
 *   緩めるだけで、候補の除外や強制はしない。ハードな
 *   ダイアトニックフィルタは意図的に入れない。
 * - 判定はセグメント単位のみ（フレーム単位の書き換えはしない、
 *   Phase 1 以来の方針）。N.C. とユーザー修正済み（edited）
 *   セグメントは対象外。信頼度は第1段のまま変えない
 *   （splitBand と同じ割り切り）。
 * - 証拠に使うクロマは呼び出し側が渡す上帯域クロマ（混合音経路は
 *   chroma.chordFrames、ステム経路は other ステムの chordFrames）。
 *   第1段のモード決め直しと同じ帯域である。当初は全帯域で設計したが、
 *   実測で全帯域はベース基音（40–60Hz 帯）の半音分解能不足により
 *   ±1 半音へ滲むことが判明した（Suno 05 の B7 区間では実在しない
 *   A# のシェアが実在の A を上回る）。上帯域では合成曲の全小節で
 *   真の 7th と三和音対照が明瞭に分離した（PHASE3_1_RESULTS.md）。
 * - 再解釈のゲートは「ベース一致＋再解釈先ルートのシェア＋適合度
 *   改善」の 3 点。検出ルート（= 7 度音）のシェア下限は課さない:
 *   上帯域では 7 度音がレジスタの都合で弱いことがあり（B7 の A は
 *   上帯域 0.037）、識別はテンプレート適合の比較が担う。再解釈先の
 *   3 度音はダイアトニックな分数コード（C/D、G/A 等）には含まれない
 *   半音上の音になるため、適合度が誤って改善することもない。
 */

/**
 * しきい値（2026-10-28、合成 Song E/F と Suno フィクスチャで調整し、
 * 実曲 1–3 には触れずに検証する。調整の記録は
 * measurements/phase3/PHASE3_1_RESULTS.md）。
 *
 * 数値の根拠（上帯域クロマでの実測、合成曲 E/F の全小節＋A–C の対照）:
 * - 真の ♭7 シェア 0.113–0.147 ／ 三和音の対照 ≤0.031 → 下限 0.08。
 * - 真の長7度シェア 0.158–0.172 ／ 対照 ≤0.068 → 下限 0.10。
 *   長7度だけ高いのは、長3度の 3 倍音が長7度クラスへ系統的に
 *   混入するため（対照実測がその床）。
 * - 持続性は真の 7th で 0.49–0.84、♭7 の対照では ≤0.35。
 */
export const EXTENSION_CONFIG = {
  /** ♭7 音ピッチクラス（dom7 / m7）のシェア（セグメント平均、L1）の下限 */
  minSeventhShare: 0.08,
  /** 長7度音ピッチクラス（maj7）のシェア下限（倍音混入ぶん高めに置く） */
  minMaj7Share: 0.1,
  /** 4 音テンプレートの適合度 − 三和音テンプレートの適合度（コサイン）の下限 */
  minFitImprovement: 0.005,
  /** 再解釈（ルート変更を伴う）に要求する適合度改善の下限（通常より厳しめ） */
  minReinterpImprovement: 0.02,
  /** 再解釈で、再解釈先ルートのシェア下限 */
  minReinterpRootShare: 0.06,
  /** 持続性: フレームのうち 7th 音シェアがこの値以上のフレームの割合の下限 */
  minPersistence: 0.4,
  /** 持続性のフレーム側しきい値（フレームクロマシェア） */
  persistenceFrameFloor: 0.04,
  /** ダイアトニックな候補へのシェアしきい値の緩和係数（柔らかい prior） */
  diatonicShareFactor: 0.9,
  /**
   * Phase 3.3: maj7 文脈 prior の割り引き係数。7th 音の背景シェア
   * （その音が他のコードの区間でも同程度に鳴っている量）にこの係数を
   * 掛けたぶんを、maj7 のシェア証拠から割り引く（下記 contextBackground）。
   * 実測の根拠: AHDN の誤発火は背景シェアとの差（excess）が概ね
   * 0.10 以下に収まる一方、合成曲の真の maj7 は差が 0.105 以上あった
   * （measurements/phase3/PHASE3_3_RESULTS.md）。
   */
  maj7ContextDiscount: 0.5,
  /** セグメント端のフレームを証拠から落とす割合（隣接コードの滲み対策） */
  edgeTrimRatio: 0.12,
  /** テンプレートの構成音重み（三和音側は chordEstimation と同じ値） */
  weights: { root: 1.0, third: 0.9, fifth: 0.75, seventh: 0.8 },
} as const;

export interface ExtensionContext {
  /** 推定キーのルート（0=C）と モード。柔らかい prior の判定にのみ使う */
  keyRoot: number;
  keyMode: "major" | "minor";
  /**
   * Phase 3.3: 局所キー文脈。渡された場合、ダイアトニック緩和の
   * キーはセグメント中点の局所キー窓で置き換える（窓が無い場合は
   * keyRoot/keyMode の全体キーを使う）。
   */
  localKeys?: LocalKeyContext;
  /**
   * Phase 3.3: maj7 文脈 prior を有効化するか。true の場合、
   * applyExtensions がセグメントごとに背景シェアを計算して
   * contextBackground に載せ、judgeExtension が maj7 の証拠を
   * 割り引く。3.1 の測定条件（文脈 prior なし）を再現する場合は
   * 未指定（false）のままにする。
   */
  contextPrior?: boolean;
  /**
   * このセグメントの maj7 音ピッチクラスについての背景シェア
   * （applyExtensions が contextPrior 有効時に計算して載せる内部値。
   * 呼び出し側が直接指定するものではない）。
   */
  contextBackground?: number;
  /**
   * Phase 3 後半: ジャンル文脈（genreProfile.ts の消費部）。
   * 曲単位のスタイル分布から導いた、拡張クラスごとのシェア
   * しきい値への乗数（0.88–1.11 にクランプ済みの柔らかい prior）。
   * 呼び出し側が消費部（オプション genre）を有効にした場合だけ
   * 渡る。候補の除外には使わず、しきい値の小さな移動だけに使う
   * （PHASE3_PLAN.md §2、ダイアトニック緩和と同じ桁の効果）。
   */
  genreFactors?: Record<ChordExtension, number>;
  /**
   * 音符レベル統合: テンションの独立証人（noteEvidence.ts）の入力。
   * 呼び出し側が noteTension を有効にした場合だけ渡る。applyExtensions
   * がセグメントごとに証人（noteWitness）を計算して judgeExtension に
   * 渡す。証拠の使い方は noteWitnessMode で選ぶ（既定は "replace"）。
   * 設計判断は measurements/notepitch/NOTEPITCH_INTEGRATION.md と、
   * v2（棄権つき証人）については NOTEPITCH_RETRY.md。
   */
  noteEvidence?: NoteEvidenceInput;
  /**
   * 証人の使い方:
   * - "replace"（v1）: 7 度音シェアを音符シェアで差し替える。
   * - "bonus"（v1 比較用）: 実在証人が強い場合にクロマシェアへ加算。
   * - "veto"（v2 主形）: クロマ判定が通した候補を、証人が発言権を
   *   持つ窓（密度ゲート＋不在の二重確認）で 7 度音が不在の場合に
   *   だけ棄却する。追加はしない。
   * - "gated"（v2 比較形）: "replace" を、証人が発言権を持つ窓に
   *   限定する（発言権が無い窓ではクロマ証拠に委ねる）。
   */
  noteWitnessMode?: "replace" | "bonus" | "gated" | "veto";
  /**
   * このセグメントの音符証人（applyExtensions が noteEvidence 有効時に
   * 計算して載せる内部値。呼び出し側が直接指定するものではない）。
   * null は「窓に音符が重ならなかった」= 証人なし（クロマに委ねる）。
   */
  noteWitness?: NoteWitness | null;
}

/**
 * 音符証人（noteTension）のパラメータ。
 * - replace: 7 度音のシェア証拠を音符シェアで差し替える。床は
 *   クロマと同じ（♭7: 0.08 / maj7: 0.10）。検証では倍音ゴースト
 *   音符のシェアは 0.03–0.08 に収まっており、床の下に落ちる。
 * - bonus（比較用）: 実在証人が強い（音符シェアと被覆率が床を
 *   超える）場合にだけ、クロマシェアへ小さな加算をする。
 * - v2（veto / gated）の発言権ゲート: 導出根拠は
 *   NOTEPITCH_RETRY.md「密度規則の導出」。密度候補（被覆率・
 *   三和音シェア等）は誤発火窓と真陽性窓を単独では分離しなかった
 *   ため、(a) は「書き起こしが機能している窓か」の資格条件として
 *   両集団の分布の下端に置き、分離の主軸は (b) 不在の二重確認
 *   （混合音プールでも不在）に置く。
 */
export const NOTE_WITNESS_CONFIG = {
  /** bonus 型: クロマシェアへの加算量 */
  bonus: 0.03,
  /** bonus 型: 証人が「強い」とみなす音符シェアの下限 */
  bonusMinNoteShare: 0.1,
  /** bonus 型: 証人が「強い」とみなす被覆率の下限 */
  bonusMinCoverage: 0.35,
  /** v2 (a) 密度ゲート: 和声プールの和集合被覆率の下限 */
  densityMinUnionCoverage: 0.75,
  /** v2 (a) 密度ゲート: 三和音構成音の音符シェア合計の下限 */
  densityMinTriadShare: 0.5,
  /** v2: 7 度音の音符シェアがこの値未満なら「不在」とみなす（検証のゴースト帯 0.03–0.08 の下） */
  absenceMaxNoteShare: 0.02,
  /** v2 (b) 二重確認: 混合音プールでの 7 度音シェアがこの値未満なら「不在が裏付けられた」とみなす */
  corroborationMaxSeventhShare: 0.05,
} as const;

/**
 * v2 証人の密度ゲート (a): その窓で和声プールの書き起こしが
 * 機能していると言えるか（和集合被覆率と、検出コードの三和音
 * 構成音が占める音符シェア合計）。証人がどちらの方向に発言する
 * 場合も、この資格を満たさない窓では棄権する。
 */
export function witnessDensityOk(
  witness: NoteWitness,
  root: number,
  mode: "major" | "minor",
): boolean {
  const third = (root + (mode === "major" ? 4 : 3)) % 12;
  const triadShare =
    witness.shares[root] + witness.shares[third] + witness.shares[(root + 7) % 12];
  return (
    witness.unionCoverage >= NOTE_WITNESS_CONFIG.densityMinUnionCoverage &&
    triadShare >= NOTE_WITNESS_CONFIG.densityMinTriadShare
  );
}

/**
 * v2 証人の棄却権: 対象ピッチクラス pc の「不在」を反証として
 * 使えるかを返す。pc の音符シェアが「不在」の水準にあり、密度
 * ゲート (a) を満たし、かつ不在が二重確認プール（混合音）でも
 * 裏付けられる場合にだけ true。二重確認プールが無い（null）
 * 場合は常に false（棄権）。実在（シェアが absenceMaxNoteShare
 * 以上）の場合は「不在の主張」自体が無いので false を返す。
 */
export function witnessMayDenyAbsence(
  witness: NoteWitness,
  root: number,
  mode: "major" | "minor",
  pc: number,
): boolean {
  if (witness.shares[pc] >= NOTE_WITNESS_CONFIG.absenceMaxNoteShare) {
    return false;
  }
  if (!witnessDensityOk(witness, root, mode)) return false;
  if (!witness.corroborationShares) return false;
  return (
    witness.corroborationShares[pc] <
    NOTE_WITNESS_CONFIG.corroborationMaxSeventhShare
  );
}

export interface SegmentEvidence {
  /** セグメント平均クロマのピッチクラスシェア（L1、合計 ≒ 1） */
  shares: Float32Array;
  /** ピッチクラスごとの持続性（シェアが床以上のフレーム割合） */
  persistence: Float32Array;
}

/**
 * セグメント区間の証拠を集める。両端のフレームは隣接コードの減衰
 * テールが混ざるため edgeTrimRatio ぶん落とす（落とした結果
 * フレームが無くなる短いセグメントでは全フレームを使う）。
 * クロマフレームは L1 正規化済み（dsp/chroma.ts）なので、
 * エネルギー加重平均もそのままシェアとして読める。
 */
export function segmentEvidence(
  chromaFrames: Float32Array[],
  energies: Float32Array,
  startIdx: number,
  endIdx: number,
): SegmentEvidence | null {
  const from0 = Math.max(0, startIdx);
  const to0 = Math.min(chromaFrames.length, endIdx);
  if (to0 - from0 <= 0) return null;
  const trim = Math.floor((to0 - from0) * EXTENSION_CONFIG.edgeTrimRatio);
  const from = to0 - from0 - trim * 2 >= 1 ? from0 + trim : from0;
  const to = to0 - from0 - trim * 2 >= 1 ? to0 - trim : to0;

  const shares = new Float32Array(12);
  let wSum = 0;
  let frames = 0;
  const aboveFloor = new Float32Array(12);
  for (let i = from; i < to; i++) {
    const w = Math.max(energies[i] ?? 0, 1e-9);
    for (let p = 0; p < 12; p++) {
      shares[p] += chromaFrames[i][p] * w;
      if (chromaFrames[i][p] >= EXTENSION_CONFIG.persistenceFrameFloor) {
        aboveFloor[p] += 1;
      }
    }
    wSum += w;
    frames += 1;
  }
  if (wSum <= 0 || frames === 0) return null;
  for (let p = 0; p < 12; p++) shares[p] /= wSum;
  const persistence = new Float32Array(12);
  for (let p = 0; p < 12; p++) persistence[p] = aboveFloor[p] / frames;
  return { shares, persistence };
}

/** 構成音（ルートからの半音間隔と重み）から L2 正規化テンプレートを作る */
function templateVector(root: number, tones: [number, number][]): Float32Array {
  const v = new Float32Array(12);
  for (const [interval, w] of tones) v[(root + interval) % 12] = w;
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < 12; i++) v[i] /= norm;
  return v;
}

function cosine(shares: Float32Array, template: Float32Array): number {
  let dot = 0;
  let norm = 0;
  for (let p = 0; p < 12; p++) {
    dot += shares[p] * template[p];
    norm += shares[p] * shares[p];
  }
  norm = Math.sqrt(norm);
  return norm > 0 ? dot / norm : 0;
}

function triadTemplate(root: number, mode: "major" | "minor"): Float32Array {
  const w = EXTENSION_CONFIG.weights;
  return templateVector(root, [
    [0, w.root],
    [mode === "major" ? 4 : 3, w.third],
    [7, w.fifth],
  ]);
}

function seventhTemplate(
  root: number,
  extension: ChordExtension,
): Float32Array {
  const w = EXTENSION_CONFIG.weights;
  const third = extension === "m7" ? 3 : 4;
  const seventh = extension === "maj7" ? 11 : 10;
  return templateVector(root, [
    [0, w.root],
    [third, w.third],
    [7, w.fifth],
    [seventh, w.seventh],
  ]);
}

const seventhPc = (root: number, extension: ChordExtension): number =>
  (root + (extension === "maj7" ? 11 : 10)) % 12;

/** 拡張音のピッチクラス（Phase 3.2 の層の再読からも使う） */
export const seventhPcOf = seventhPc;

/** 三和音テンプレートへの適合度（Phase 3.2 の層の再読用に公開） */
export function triadTemplateFit(
  shares: Float32Array,
  root: number,
  mode: "major" | "minor",
): number {
  return cosine(shares, triadTemplate(root, mode));
}

/** 7th テンプレートへの適合度（Phase 3.2 の層の再読用に公開） */
export function seventhTemplateFit(
  shares: Float32Array,
  root: number,
  extension: ChordExtension,
): number {
  return cosine(shares, seventhTemplate(root, extension));
}

export interface TemplateCandidate {
  root: number;
  mode: "major" | "minor";
  /** 7th テンプレートが選ばれた場合のみ（maj7 / 7 / m7） */
  extension?: ChordExtension;
  fit: number;
}

/**
 * 三和音＋7th テンプレート群の中での最良候補を返す（Phase 3.2 の
 * 層の再読専用。第2段の判定には使わない）。語彙は第2段と同じ:
 * major ルートには maj7 / dom7、minor ルートには m7。
 * bestTriad は三和音だけでの最良（7th 採用の比較基準）。
 */
export function bestTemplateCandidate(shares: Float32Array): {
  best: TemplateCandidate;
  bestTriad: TemplateCandidate;
} {
  let best: TemplateCandidate | null = null;
  let bestTriad: TemplateCandidate | null = null;
  for (let root = 0; root < 12; root++) {
    const triads: TemplateCandidate[] = [
      { root, mode: "major", fit: cosine(shares, triadTemplate(root, "major")) },
      { root, mode: "minor", fit: cosine(shares, triadTemplate(root, "minor")) },
    ];
    const sevenths: TemplateCandidate[] = [
      { root, mode: "major", extension: "maj7", fit: cosine(shares, seventhTemplate(root, "maj7")) },
      { root, mode: "major", extension: "7", fit: cosine(shares, seventhTemplate(root, "7")) },
      { root, mode: "minor", extension: "m7", fit: cosine(shares, seventhTemplate(root, "m7")) },
    ];
    for (const c of triads) {
      if (!bestTriad || c.fit > bestTriad.fit) bestTriad = c;
      if (!best || c.fit > best.fit) best = c;
    }
    for (const c of sevenths) {
      if (!best || c.fit > best.fit) best = c;
    }
  }
  return { best: best!, bestTriad: bestTriad! };
}

/**
 * 候補が推定キーの中でダイアトニックな機能を持つか（柔らかい prior 用）。
 * - major キー: maj7 = I／IV、dom7 = V、m7 = ii／iii／vi
 * - minor キー: m7 = i／ii、dom7 = V（和声的短音階のドミナント）、
 *   maj7 = III／VI
 * ここに無い候補は「あり得ない」ではなく単に緩和を受けないだけ。
 */
export function isDiatonicExtension(
  root: number,
  extension: ChordExtension,
  ctx: ExtensionContext,
): boolean {
  const rel = (((root - ctx.keyRoot) % 12) + 12) % 12;
  if (ctx.keyMode === "major") {
    if (extension === "maj7") return rel === 0 || rel === 5;
    if (extension === "7") return rel === 7;
    return rel === 2 || rel === 4 || rel === 9; // m7
  }
  if (extension === "m7") return rel === 0 || rel === 2;
  if (extension === "7") return rel === 7;
  return rel === 3 || rel === 8; // maj7: III / VI
}

export interface ExtensionVerdict {
  /** 付ける拡張音。付けない場合は undefined */
  extension?: ChordExtension;
  /** 再解釈が発火した場合の新しいルート（major 固定）。通常は undefined */
  rootOverride?: number;
}

/**
 * 1 セグメント分の第2段判定（純粋関数、単体テスト対象）。
 * 証拠が足りなければ空の判定（= 三和音のまま）を返す。
 */
export function judgeExtension(
  chord: string,
  bassPc: number | undefined,
  evidence: SegmentEvidence,
  ctx?: ExtensionContext,
): ExtensionVerdict {
  const parsed = parseChordName(chord);
  if (!parsed) return {};
  const { root, mode } = parsed;
  const { shares, persistence } = evidence;
  const fit3 = cosine(shares, triadTemplate(root, mode));

  // (a)(b) 検出ルートのままの拡張候補
  const onRoot: ChordExtension[] =
    mode === "major" ? ["maj7", "7"] : ["m7"];
  let bestOnRoot: { extension: ChordExtension; fit: number } | null = null;
  // 文脈 prior で割り引く前の最良候補。再解釈との競合はこちらと
  // 比較する（下記の再解釈ブロックのコメント参照）
  let bestOnRootRaw: { extension: ChordExtension; fit: number } | null = null;
  for (const ext of onRoot) {
    const pc = seventhPc(root, ext);
    let shareThreshold =
      ext === "maj7" ? EXTENSION_CONFIG.minMaj7Share : EXTENSION_CONFIG.minSeventhShare;
    if (ctx && isDiatonicExtension(root, ext, ctx)) {
      shareThreshold *= EXTENSION_CONFIG.diatonicShareFactor;
    }
    // Phase 3 後半: ジャンル文脈。その曲のスタイル傾向として
    // その拡張クラスが常套なら僅かに緩め、稀なら僅かに厳しくする。
    // ダイアトニック緩和とは独立に掛かる（両方とも柔らかい prior）。
    if (ctx?.genreFactors) {
      shareThreshold *= ctx.genreFactors[ext];
    }
    // 音符レベル統合: テンションの独立証人（noteTension）。7 度音の
    // シェア証拠だけを音符側の実在証拠で扱う（持続性・適合度は
    // クロマ側のまま）。"replace" はクロマでは倍音で膨らむ 7 度音
    // シェアを、音符の実在シェア（ゴースト帯 0.03–0.08）に差し替え、
    // 床に届かない誤発火をゲートで落とすのが狙い。"bonus" は比較用
    // （NOTEPITCH_INTEGRATION.md の設計判断参照）。
    // v2（NOTEPITCH_RETRY.md）: "veto" はクロマ判定を通した候補を、
    // 証人が棄却権を持つ窓（密度ゲート＋不在の二重確認）でのみ
    // 棄却する。"gated" は "replace" の適用を、証人に発言権がある
    // 窓（密度ゲートを満たし、実在が確認できるか、不在が二重確認
    // できる場合）に限定し、それ以外では棄権する（クロマに委ねる）。
    const witnessMode = ctx?.noteWitnessMode ?? "replace";
    let effectiveShare = shares[pc];
    // この候補のシェア証拠が音符側に差し替わったか（下記の文脈
    // prior 割り引きを止める条件。replace では常時、gated では
    // 差し替えが実際に起きた候補だけ true になる）
    let witnessReplaced = false;
    // v2 veto: 全ゲートを通した候補に適用する棄却フラグ
    let vetoed = false;
    if (ctx?.noteWitness) {
      const w = ctx.noteWitness;
      const noteShare = w.shares[pc];
      if (witnessMode === "bonus") {
        if (
          noteShare >= NOTE_WITNESS_CONFIG.bonusMinNoteShare &&
          w.coverage[pc] >= NOTE_WITNESS_CONFIG.bonusMinCoverage
        ) {
          effectiveShare = shares[pc] + NOTE_WITNESS_CONFIG.bonus;
        }
      } else if (witnessMode === "gated") {
        const presence =
          noteShare >= NOTE_WITNESS_CONFIG.absenceMaxNoteShare;
        if (
          witnessDensityOk(w, root, mode) &&
          (presence || witnessMayDenyAbsence(w, root, mode, pc))
        ) {
          effectiveShare = noteShare;
          witnessReplaced = true;
        }
      } else if (witnessMode === "veto") {
        vetoed = witnessMayDenyAbsence(w, root, mode, pc);
      } else {
        effectiveShare = noteShare;
        witnessReplaced = true;
      }
    }
    // Phase 3.3: maj7 文脈 prior。その音が曲の他のコード区間でも
    // 同程度に鳴っている（背景シェアが高い）場合、その音はこの
    // セグメント固有の構成音とは言い切れないため、シェア証拠を
    // 背景ぶん割り引いてからしきい値と比較する。割り引くのは
    // シェア判定だけで、適合度・持続性の判定は元の証拠のまま。
    // （PHASE3_1_RESULTS.md 失敗分析3: AHDN の G → GM7 誤発火対策）
    // 音符証人の差し替え時は、証拠の出所が音符側に移っているため
    // クロマ固有の背景割り引きは適用しない。
    let shareForTest = effectiveShare;
    if (
      ext === "maj7" &&
      ctx?.contextBackground !== undefined &&
      !witnessReplaced
    ) {
      shareForTest =
        effectiveShare - EXTENSION_CONFIG.maj7ContextDiscount * ctx.contextBackground;
    }
    if (effectiveShare < shareThreshold) continue; // 割り引き前のゲートにも届かない
    if (persistence[pc] < EXTENSION_CONFIG.minPersistence) continue;
    const fit = cosine(shares, seventhTemplate(root, ext));
    if (fit - fit3 < EXTENSION_CONFIG.minFitImprovement) continue;
    // v2 veto: クロマ側の全ゲートを通しても、証人の棄却権が成立
    // する窓では候補自体を存在しないものとして扱う（再解釈との
    // 競合相手（bestOnRootRaw）にも数えない）
    if (vetoed) continue;
    if (!bestOnRootRaw || fit > bestOnRootRaw.fit) {
      bestOnRootRaw = { extension: ext, fit };
    }
    if (shareForTest < shareThreshold) continue; // 文脈 prior で抑制された
    if (!bestOnRoot || fit > bestOnRoot.fit) bestOnRoot = { extension: ext, fit };
  }

  // (c) 7th ハイジャック再解釈（major 検出時のみ、ベース証拠が必須）
  let reinterp: { fit: number } | null = null;
  if (mode === "major" && bassPc !== undefined) {
    const root2 = (root + 2) % 12;
    if (((bassPc % 12) + 12) % 12 === root2) {
      const fit = cosine(shares, seventhTemplate(root2, "7"));
      if (
        fit - fit3 >= EXTENSION_CONFIG.minReinterpImprovement &&
        shares[root2] >= EXTENSION_CONFIG.minReinterpRootShare
      ) {
        reinterp = { fit };
      }
    }
  }

  // 再解釈と同ルート拡張が両方立つ場合は適合度の高い方。
  // 再解釈はルートを動かす分、同点近くでは同ルート側を優先する。
  // 競合相手は文脈 prior で割り引く前の最良候補にする: 割り引きで
  // maj7 が抑制された結果として「同ルート候補が無い」ことになり、
  // 本来負けていた再解釈が浮上してルートまで動かしてしまう
  // カスケードを防ぐため（実測: 混合音・曲1 の 131.5–132.7 秒で
  // DM7 → E7 化し root/core を落とした。PHASE3_3_RESULTS.md）
  if (reinterp && (!bestOnRootRaw || reinterp.fit > bestOnRootRaw.fit)) {
    return { extension: "7", rootOverride: (root + 2) % 12 };
  }
  if (bestOnRoot) return { extension: bestOnRoot.extension };
  return {};
}

/** 三和音の構成音ピッチクラス（背景シェアの集計で「その音が構成音の区間」を除くため） */
function triadTones(root: number, mode: "major" | "minor"): number[] {
  return [root, (root + (mode === "major" ? 4 : 3)) % 12, (root + 7) % 12];
}

function medianOf(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/**
 * maj7 音ピッチクラス pc の背景シェア: ルートが candidateRoot と異なり、
 * pc がそのコードの三和音構成音でもないセグメント群における
 * shares[pc] の中央値。「その音が、このコードでなくても同程度に
 * 鳴っている量」の推定（Phase 3.3 の文脈 prior 用）。
 */
function backgroundShare(
  pc: number,
  candidateRoot: number,
  parsedList: ({ root: number; mode: "major" | "minor" } | null)[],
  evidences: (SegmentEvidence | null)[],
): number {
  const xs: number[] = [];
  for (let j = 0; j < parsedList.length; j++) {
    const p = parsedList[j];
    const ev = evidences[j];
    if (!p || !ev) continue;
    if (p.root === candidateRoot) continue;
    if (triadTones(p.root, p.mode).includes(pc)) continue;
    xs.push(ev.shares[pc]);
  }
  return medianOf(xs);
}

/**
 * セグメント列に第2段（拡張音検出）を適用した新しい配列を返す
 * （入力は変更しない）。ルート・モード・境界・信頼度・bassPc は
 * 再解釈が発火したセグメントのルートを除き一切変えない。
 *
 * Phase 3.3 の文脈（ctx.localKeys / ctx.contextPrior）がある場合のみ、
 * セグメントごとに (a) ダイアトニック緩和のキーを局所キーへ差し替え、
 * (b) maj7 の背景シェアを計算して judgeExtension に渡す。
 * 文脈なしの呼び出しは Phase 3.1 の測定条件と同一の動作になる。
 */
export function applyExtensions(
  segments: ChordSegment[],
  chromaFrames: Float32Array[],
  energies: Float32Array,
  frameDuration: number,
  ctx?: ExtensionContext,
): ChordSegment[] {
  const parsedList = segments.map((seg) => parseChordName(seg.chord));
  const evidences = segments.map((seg, i) => {
    if (seg.edited || !parsedList[i]) return null;
    const startIdx = Math.floor(seg.start / frameDuration);
    const endIdx = Math.max(startIdx + 1, Math.ceil(seg.end / frameDuration));
    return segmentEvidence(chromaFrames, energies, startIdx, endIdx);
  });

  return segments.map((seg, i) => {
    const parsed = parsedList[i];
    const evidence = evidences[i];
    if (seg.edited || !parsed || !evidence) return seg;
    let segCtx = ctx;
    if (ctx && (ctx.localKeys || ctx.contextPrior || ctx.noteEvidence)) {
      segCtx = { ...ctx };
      if (ctx.noteEvidence) {
        // 音符証人: 和声音符が窓に重ならなければ null（クロマに委ねる）。
        // 二重確認プール（混合音の音符列）があれば併せて渡す（v2）
        segCtx.noteWitness = noteSegmentWitness(
          ctx.noteEvidence.harmony,
          seg.start,
          seg.end,
          ctx.noteEvidence.corroboration,
        );
      }
      if (ctx.localKeys) {
        const win = localKeyWindowAt(ctx.localKeys, (seg.start + seg.end) / 2);
        if (win) {
          segCtx.keyRoot = win.root;
          segCtx.keyMode = win.mode;
        }
      }
      if (ctx.contextPrior && parsed.mode === "major") {
        const pc = (parsed.root + 11) % 12;
        segCtx.contextBackground = backgroundShare(
          pc,
          parsed.root,
          parsedList,
          evidences,
        );
      }
    }
    const verdict = judgeExtension(seg.chord, seg.bassPc, evidence, segCtx);
    if (verdict.rootOverride !== undefined && verdict.extension) {
      return {
        ...seg,
        chord: chordName(verdict.rootOverride, "major"),
        extension: verdict.extension,
      };
    }
    if (verdict.extension) return { ...seg, extension: verdict.extension };
    return seg;
  });
}

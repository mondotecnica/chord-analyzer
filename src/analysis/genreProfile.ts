import { NO_CHORD } from "../lib/notes";
import type {
  ChordExtension,
  ChordSegment,
  GenreFeatures,
  GenreHarmonyFeatures,
  GenreMelodyFeatures,
  GenreProfile,
  GenreRhythmFeatures,
  GenreStyleId,
  GenreTimbreFeatures,
} from "../types";
import { parseChordName } from "./bassCorrection";
import { segmentEvidence } from "./extensionDetection";
import { chordKeyPlausibility, keyScalePcs } from "./localKey";

/**
 * Phase 3 後半: ジャンル傾向モジュール＝「様式プロファイル」推定
 * （PHASE3_PLAN.md §3 の後半の柱、理論レイヤーの規則は §2、
 * 設計原則は DESIGN_NOTES.md）。
 *
 * ## 何を出すか — 単一ラベルではなく混合比率
 *
 * ジャンルは歴史的に、人の移動と各地の様式の混合で形成されて
 * きたものであり、1曲を1ジャンルに断定する表現は実態に合わない
 * （2026-10-28 のユーザーの設計観）。そこで本モジュールの出力は
 * 「様式ファミリーへの混合比率（分布）」そのものにする。下流の
 * prior（第2段への係数）も分布で重み付けした混合として効く
 * ため、比率は装飾ではなく機能する。top は表示の便宜であり
 * 判定ではない（§2 の「判定を出さない」規則、局所キーと同じ）。
 *
 * ## 正直さの境界（重要）
 *
 * このパーセンテージは「特徴空間における様式プロトタイプへの
 * 類似度」であって、**文化的系譜そのものの比率ではない**。
 * どの土地の伝統が何割受け継がれたかは音響特徴からは測れない。
 * 本モジュールが測るのは「この曲の音響的特徴が、どの様式の
 * 典型像に、どれだけ似ているか」までである。表示・書き出し・
 * 文書では「様式プロファイル（推定）」と呼び、系譜の比率と
 * 誤読される表現は使わない。
 *
 * ## 特徴量のチャンネル構成（音楽の三大要素＋音色）
 *
 * - 和声（コード）: 第1段セグメント列＋証拠クロマから常に計算
 *   できる。7th プレゼンス、ダイアトニック度、二次ドミナント、
 *   5度下行、語彙、分数コード割合、♭VII など。
 * - リズム: オンセット包絡（密度・拍の規則性）と和声リズム
 *   （コード変化率）。ステム経路ではドラムステムの包絡を優先
 *   する。検出 BPM そのものは倍取り／3:2 の取り違えが実測
 *   されているため特徴量に入れない（拍の規則性は包絡の
 *   自己相関で測り、BPM の絶対値には依存しない）。
 * - メロディ: ボーカルステムがある場合のみ。ボーカルクロマの
 *   スケール適合度とコードトーン比率。混合音経路では分離されて
 *   いないため測れない — その場合はチャンネル自体を欠落として
 *   記録し、無いものをあるように見せない。
 * - 音色: 4ステムが揃う場合のみ、ステム RMS シェア。
 *   混合音経路では測れない（同上）。
 *
 * ## 推定方法
 *
 * 学習済み分類器ではなく「傾向表スコアリング」: スタイルごとの
 * 傾向（中心 μ・広がり σ）へのガウス類似度の重み付き平均を
 * softmax で分布化する。傾向表は音楽学的な常識に基づく手置きの
 * 値で、定数の較正は合成曲と Suno フィクスチャの範囲でのみ
 * 行った（実曲は検証専用。経緯は
 * measurements/phase3/PHASE3_GENRE_RESULTS.md）。新規チャンネル
 * （リズム／メロディ／音色）の傾向は識別力が未検証のため、
 * 広い σ と小さい重みで「弱く効く」置き方にしている。
 *
 * ## 記録と消費（3.3 分割採用と同じ規律）
 *
 * - 記録（明示オプトイン、オプション genreRecord。既定 OFF。
 *   2026-10-28 のユーザー判断で分割採用は取らず、記録も既定
 *   OFF として公開）: 推定＋格納＋表示のみ。ラベルには一切
 *   触れない。DESIGN_NOTES が共有
 *   プロファイル項目として挙げた「ジャンル推定と信頼度」の
 *   実体であり、将来の他用途（分離調整／MIDI 変換／
 *   マスタリング基準）もこのフィールドを読む形で接続する。
 * - 消費（既定 OFF、オプション genre）: 第2段のシェア
 *   しきい値への曲単位の係数としてのみ効く柔らかい prior。
 *   候補の除外はしない（§2）。
 */

/** スタイルの列挙順（同点時の argmax はこの順＝最も無難な pop が先頭） */
export const GENRE_STYLES: GenreStyleId[] = [
  "pop",
  "jazz",
  "blues",
  "soul",
  "rock",
];

export const GENRE_CONFIG = {
  /** softmax の温度。小さいほど分布が尖る */
  softmaxTemperature: 0.07,
  /** 消費部の係数の下限・上限（judgeExtension のシェアしきい値への乗数） */
  factorMin: 0.88,
  factorMax: 1.11,
  /** 親和度 0→1 を係数へ写す傾き。factor = clamp(1.11 − 0.23 × 親和度) */
  factorSlope: 0.23,
  factorBase: 1.11,
} as const;

/**
 * スタイル別「拡張クラスの親和度」（0..1）。音楽常識レベルの傾向:
 * - jazz: 全種の 7th がトニックでも常套
 * - blues: dom7 が I／IV の色そのもの。maj7 は稀
 * - soul: maj7／m7 のトニック色付けが常套
 * - pop: 7th は V7 と vi の m7 が中心
 * - rock: 三和音主体。maj7 は稀、7th は V 中心
 */
export const GENRE_EXTENSION_AFFINITY: Record<
  GenreStyleId,
  Record<ChordExtension, number>
> = {
  jazz: { maj7: 1.0, "7": 1.0, m7: 1.0 },
  blues: { maj7: 0.15, "7": 1.0, m7: 0.6 },
  soul: { maj7: 0.85, "7": 0.7, m7: 0.9 },
  pop: { maj7: 0.45, "7": 0.55, m7: 0.6 },
  rock: { maj7: 0.1, "7": 0.4, m7: 0.35 },
};

interface Tendency {
  mu: number;
  sigma: number;
  weight: number;
}

/** スコアリングに使う平坦化した特徴量キー */
type ScoredFeatureKey =
  | keyof GenreHarmonyFeatures
  | "changesPerMinute"
  | "onsetDensity"
  | "pulseRegularity"
  | "melodyScaleConformance"
  | "melodyChordToneRatio"
  | "timbreBassShare"
  | "timbreDrumsShare";

/**
 * スタイルごとの特徴量傾向（中心 μ・広がり σ・重み）。
 * 和声チャンネルの数値は音楽常識に基づく手置き＋合成曲／Suno
 * での較正（PHASE3_GENRE_RESULTS.md「調整の経緯」）。プレゼンス系は
 * 上帯域クロマでのセグメント平均シェアの実測レンジ（真の 7th
 * ≈ 0.11–0.17、三和音対照 ≲ 0.07。PHASE3_1_RESULTS.md）を踏む。
 * リズム／メロディ／音色チャンネルは識別力が未検証のため、
 * 広い σ・小さい重みで弱く効かせる。
 */
const GENRE_TENDENCIES: Record<GenreStyleId, Record<ScoredFeatureKey, Tendency>> = {
  jazz: {
    maj7Presence: { mu: 0.085, sigma: 0.05, weight: 1.0 },
    dom7Presence: { mu: 0.085, sigma: 0.05, weight: 1.0 },
    m7Presence: { mu: 0.11, sigma: 0.05, weight: 0.9 },
    diatonicShare: { mu: 0.85, sigma: 0.13, weight: 1.0 },
    secondaryDominantShare: { mu: 0.1, sigma: 0.07, weight: 1.0 },
    fifthDescentShare: { mu: 0.45, sigma: 0.2, weight: 0.5 },
    minorShare: { mu: 0.35, sigma: 0.3, weight: 0.3 },
    slashShare: { mu: 0.2, sigma: 0.18, weight: 0.5 },
    flatVIIShare: { mu: 0.02, sigma: 0.04, weight: 0.9 },
    vocabSize: { mu: 13, sigma: 6, weight: 0.6 },
    changesPerMinute: { mu: 30, sigma: 12, weight: 0.4 },
    onsetDensity: { mu: 3.0, sigma: 1.6, weight: 0.35 },
    pulseRegularity: { mu: 0.45, sigma: 0.28, weight: 0.3 },
    melodyScaleConformance: { mu: 0.78, sigma: 0.13, weight: 0.3 },
    melodyChordToneRatio: { mu: 0.55, sigma: 0.2, weight: 0.3 },
    timbreBassShare: { mu: 0.22, sigma: 0.13, weight: 0.25 },
    timbreDrumsShare: { mu: 0.24, sigma: 0.14, weight: 0.25 },
  },
  blues: {
    maj7Presence: { mu: 0.02, sigma: 0.03, weight: 1.0 },
    dom7Presence: { mu: 0.13, sigma: 0.05, weight: 1.0 },
    m7Presence: { mu: 0.07, sigma: 0.05, weight: 0.9 },
    diatonicShare: { mu: 0.92, sigma: 0.09, weight: 1.0 },
    secondaryDominantShare: { mu: 0.02, sigma: 0.03, weight: 1.0 },
    fifthDescentShare: { mu: 0.35, sigma: 0.2, weight: 0.5 },
    minorShare: { mu: 0.12, sigma: 0.2, weight: 0.3 },
    slashShare: { mu: 0.05, sigma: 0.08, weight: 0.5 },
    flatVIIShare: { mu: 0.03, sigma: 0.05, weight: 0.9 },
    vocabSize: { mu: 6, sigma: 3, weight: 0.6 },
    changesPerMinute: { mu: 24, sigma: 11, weight: 0.4 },
    onsetDensity: { mu: 2.0, sigma: 1.3, weight: 0.35 },
    pulseRegularity: { mu: 0.6, sigma: 0.27, weight: 0.3 },
    melodyScaleConformance: { mu: 0.85, sigma: 0.12, weight: 0.3 },
    melodyChordToneRatio: { mu: 0.6, sigma: 0.2, weight: 0.3 },
    timbreBassShare: { mu: 0.25, sigma: 0.13, weight: 0.25 },
    timbreDrumsShare: { mu: 0.22, sigma: 0.14, weight: 0.25 },
  },
  soul: {
    maj7Presence: { mu: 0.07, sigma: 0.05, weight: 1.0 },
    dom7Presence: { mu: 0.06, sigma: 0.04, weight: 1.0 },
    m7Presence: { mu: 0.1, sigma: 0.05, weight: 0.9 },
    diatonicShare: { mu: 0.88, sigma: 0.11, weight: 1.0 },
    secondaryDominantShare: { mu: 0.05, sigma: 0.05, weight: 1.0 },
    fifthDescentShare: { mu: 0.35, sigma: 0.2, weight: 0.5 },
    minorShare: { mu: 0.32, sigma: 0.3, weight: 0.3 },
    slashShare: { mu: 0.15, sigma: 0.15, weight: 0.5 },
    flatVIIShare: { mu: 0.02, sigma: 0.04, weight: 0.9 },
    vocabSize: { mu: 10, sigma: 5, weight: 0.6 },
    changesPerMinute: { mu: 20, sigma: 9, weight: 0.4 },
    onsetDensity: { mu: 2.2, sigma: 1.3, weight: 0.35 },
    pulseRegularity: { mu: 0.6, sigma: 0.27, weight: 0.3 },
    melodyScaleConformance: { mu: 0.88, sigma: 0.12, weight: 0.3 },
    melodyChordToneRatio: { mu: 0.65, sigma: 0.2, weight: 0.3 },
    timbreBassShare: { mu: 0.27, sigma: 0.13, weight: 0.25 },
    timbreDrumsShare: { mu: 0.23, sigma: 0.14, weight: 0.25 },
  },
  pop: {
    maj7Presence: { mu: 0.045, sigma: 0.035, weight: 1.0 },
    dom7Presence: { mu: 0.04, sigma: 0.035, weight: 1.0 },
    m7Presence: { mu: 0.05, sigma: 0.04, weight: 0.9 },
    diatonicShare: { mu: 0.96, sigma: 0.06, weight: 1.0 },
    secondaryDominantShare: { mu: 0.02, sigma: 0.03, weight: 1.0 },
    fifthDescentShare: { mu: 0.32, sigma: 0.2, weight: 0.5 },
    minorShare: { mu: 0.32, sigma: 0.3, weight: 0.3 },
    slashShare: { mu: 0.08, sigma: 0.1, weight: 0.5 },
    flatVIIShare: { mu: 0.02, sigma: 0.04, weight: 0.9 },
    vocabSize: { mu: 8, sigma: 4, weight: 0.6 },
    changesPerMinute: { mu: 22, sigma: 10, weight: 0.4 },
    onsetDensity: { mu: 2.6, sigma: 1.4, weight: 0.35 },
    pulseRegularity: { mu: 0.7, sigma: 0.24, weight: 0.3 },
    melodyScaleConformance: { mu: 0.9, sigma: 0.1, weight: 0.3 },
    melodyChordToneRatio: { mu: 0.7, sigma: 0.2, weight: 0.3 },
    timbreBassShare: { mu: 0.24, sigma: 0.13, weight: 0.25 },
    timbreDrumsShare: { mu: 0.25, sigma: 0.14, weight: 0.25 },
  },
  rock: {
    maj7Presence: { mu: 0.025, sigma: 0.03, weight: 1.0 },
    dom7Presence: { mu: 0.035, sigma: 0.035, weight: 1.0 },
    m7Presence: { mu: 0.035, sigma: 0.035, weight: 0.9 },
    diatonicShare: { mu: 0.88, sigma: 0.11, weight: 1.0 },
    secondaryDominantShare: { mu: 0.02, sigma: 0.03, weight: 1.0 },
    fifthDescentShare: { mu: 0.28, sigma: 0.2, weight: 0.5 },
    minorShare: { mu: 0.28, sigma: 0.3, weight: 0.3 },
    slashShare: { mu: 0.06, sigma: 0.09, weight: 0.5 },
    flatVIIShare: { mu: 0.1, sigma: 0.09, weight: 0.9 },
    vocabSize: { mu: 8, sigma: 4, weight: 0.6 },
    changesPerMinute: { mu: 26, sigma: 11, weight: 0.4 },
    onsetDensity: { mu: 3.2, sigma: 1.6, weight: 0.35 },
    pulseRegularity: { mu: 0.7, sigma: 0.24, weight: 0.3 },
    melodyScaleConformance: { mu: 0.88, sigma: 0.12, weight: 0.3 },
    melodyChordToneRatio: { mu: 0.68, sigma: 0.2, weight: 0.3 },
    timbreBassShare: { mu: 0.26, sigma: 0.13, weight: 0.25 },
    timbreDrumsShare: { mu: 0.28, sigma: 0.14, weight: 0.25 },
  },
};

/** 追加チャンネルの入力（存在する経路だけ渡す。無ければ欠落として扱う） */
export interface GenreChannelInputs {
  /** リズム: オンセット包絡（ステム経路ではドラム優先、呼び出し側が選ぶ） */
  onsetEnvelope?: Float32Array;
  onsetFrameDuration?: number;
  /** メロディ: ボーカルステムのクロマ（computeChromagram の結果） */
  melodyChroma?: {
    frames: Float32Array[];
    energies: Float32Array;
    frameDuration: number;
  };
  /** 音色: 4ステムの RMS（全て揃う場合のみ渡す） */
  stemRms?: { vocals: number; drums: number; bass: number; other: number };
}

interface ParsedSeg {
  root: number;
  mode: "major" | "minor";
  dur: number;
  bassPc?: number;
}

export function parseSegments(segments: ChordSegment[]): (ParsedSeg | null)[] {
  return segments.map((seg) => {
    if (seg.chord === NO_CHORD) return null;
    const p = parseChordName(seg.chord);
    if (!p) return null;
    return {
      root: p.root,
      mode: p.mode,
      dur: Math.max(0, seg.end - seg.start),
      bassPc: seg.bassPc,
    };
  });
}

/**
 * 和声チャンネル＋和声リズム（変化率）の特徴量。
 * プレゼンス系は extensionDetection.segmentEvidence（第2段と
 * 同じ集計: 端トリム＋エネルギー加重）をそのまま使う。
 * 遷移系はラン（同一コードの連続を畳んだ列）で見る: 第1段の
 * セグメントは小節内で割れることが多く、生の境界では遷移の
 * 実態が断片化に埋もれるため（較正時の実測）。
 * ♭VII は長調キーでのみ測る（短調では VII はダイアトニック）。
 */
export function extractHarmonyFeatures(
  segments: ChordSegment[],
  parsed: (ParsedSeg | null)[],
  chromaFrames: Float32Array[],
  energies: Float32Array,
  frameDuration: number,
  keyRoot: number,
  keyMode: "major" | "minor",
  durationSec: number,
): { harmony: GenreHarmonyFeatures; changesPerMinute: number } {
  const labelled = parsed.filter((p): p is ParsedSeg => p !== null);
  const labelledTime = labelled.reduce((a, p) => a + p.dur, 0);

  // プレゼンス（7 度音ピッチクラスのセグメント平均シェア、時間加重）
  let maj7Acc = 0;
  let maj7Time = 0;
  let dom7Acc = 0;
  let dom7Time = 0;
  let m7Acc = 0;
  let m7Time = 0;
  segments.forEach((seg, i) => {
    const p = parsed[i];
    if (!p || p.dur <= 0) return;
    const startIdx = Math.floor(seg.start / frameDuration);
    const endIdx = Math.max(startIdx + 1, Math.ceil(seg.end / frameDuration));
    const ev = segmentEvidence(chromaFrames, energies, startIdx, endIdx);
    if (!ev) return;
    if (p.mode === "major") {
      maj7Acc += ev.shares[(p.root + 11) % 12] * p.dur;
      maj7Time += p.dur;
      dom7Acc += ev.shares[(p.root + 10) % 12] * p.dur;
      dom7Time += p.dur;
    } else {
      m7Acc += ev.shares[(p.root + 10) % 12] * p.dur;
      m7Time += p.dur;
    }
  });

  // ラベル系（時間加重は生セグメントで集計）
  let diatonicAcc = 0;
  let minorTime = 0;
  let slashTime = 0;
  let flatVIITime = 0;
  const vocab = new Set<number>();
  const flatVIIRoot = (keyRoot + 10) % 12;
  for (const p of parsed) {
    if (!p) continue;
    vocab.add(p.root * 2 + (p.mode === "major" ? 0 : 1));
    diatonicAcc +=
      chordKeyPlausibility(p.root, p.mode, keyRoot, keyMode) * p.dur;
    if (p.mode === "minor") minorTime += p.dur;
    if (p.bassPc !== undefined && ((p.bassPc % 12) + 12) % 12 !== p.root) {
      slashTime += p.dur;
    }
    if (p.mode === "major" && p.root === flatVIIRoot) flatVIITime += p.dur;
  }

  // 遷移系はランで見る
  const runs: ParsedSeg[] = [];
  for (const p of parsed) {
    if (!p) continue;
    const last = runs[runs.length - 1];
    if (last && last.root === p.root && last.mode === p.mode) {
      last.dur += p.dur;
    } else {
      runs.push({ ...p });
    }
  }
  let secDomTime = 0;
  let fifthPairs = 0;
  let fifthHits = 0;
  for (let i = 0; i < runs.length; i++) {
    const cur = runs[i];
    const next = runs[i + 1];
    if (!next) break;
    fifthPairs += 1;
    const descent = (next.root - cur.root + 12) % 12 === 5;
    if (descent) fifthHits += 1;
    // 二次ドミナント形: 非ダイアトニック（plausibility < 1）な長三和音が、
    // 完全にダイアトニックなコードへ5度下行で解決する。ルート自体は
    // スケール内のこともある（短調の V/V は ii のルートを持ち、
    // 3 度だけが調性外になる）ため、ルートの条件は置かない。
    if (
      cur.mode === "major" &&
      chordKeyPlausibility(cur.root, cur.mode, keyRoot, keyMode) < 1 - 1e-9 &&
      descent &&
      chordKeyPlausibility(next.root, next.mode, keyRoot, keyMode) >= 1 - 1e-9
    ) {
      secDomTime += cur.dur;
    }
  }

  const t = labelledTime > 0 ? labelledTime : 0;
  return {
    harmony: {
      maj7Presence: maj7Time > 0 ? maj7Acc / maj7Time : null,
      dom7Presence: dom7Time > 0 ? dom7Acc / dom7Time : null,
      m7Presence: m7Time > 0 ? m7Acc / m7Time : null,
      diatonicShare: t > 0 ? diatonicAcc / t : 0,
      secondaryDominantShare: t > 0 ? secDomTime / t : 0,
      fifthDescentShare: fifthPairs > 0 ? fifthHits / fifthPairs : 0,
      minorShare: t > 0 ? minorTime / t : 0,
      slashShare: t > 0 ? slashTime / t : 0,
      flatVIIShare: keyMode === "major" ? (t > 0 ? flatVIITime / t : 0) : null,
      vocabSize: vocab.size,
    },
    changesPerMinute: durationSec > 0 ? runs.length / (durationSec / 60) : 0,
  };
}

/**
 * リズムチャンネル: オンセット包絡から密度と拍の規則性を測る。
 * - 密度: 平均＋0.5σ を超える局所ピークの数／秒。
 * - 規則性: 平均を引いた包絡の自己相関について、0.3–1.5 秒の
 *   ラグ範囲での最大値を lag 0 で割ったもの（0..1 にクランプ）。
 *   検出 BPM の絶対値には依存しない。
 */
export function extractRhythmFromOnset(
  onsetEnvelope: Float32Array,
  frameDuration: number,
  durationSec: number,
): { onsetDensity: number | null; pulseRegularity: number | null } {
  const n = onsetEnvelope.length;
  if (n < 8 || frameDuration <= 0 || durationSec <= 0) {
    return { onsetDensity: null, pulseRegularity: null };
  }
  let mean = 0;
  for (const v of onsetEnvelope) mean += v;
  mean /= n;
  let varSum = 0;
  for (const v of onsetEnvelope) varSum += (v - mean) * (v - mean);
  const std = Math.sqrt(varSum / n);
  const threshold = mean + 0.5 * std;
  let peaks = 0;
  for (let i = 1; i < n - 1; i++) {
    if (
      onsetEnvelope[i] > threshold &&
      onsetEnvelope[i] >= onsetEnvelope[i - 1] &&
      onsetEnvelope[i] >= onsetEnvelope[i + 1]
    ) {
      peaks += 1;
    }
  }
  const onsetDensity = peaks / durationSec;

  const minLag = Math.max(1, Math.floor(0.3 / frameDuration));
  const maxLag = Math.min(n - 1, Math.ceil(1.5 / frameDuration));
  let r0 = 0;
  for (let i = 0; i < n; i++) r0 += (onsetEnvelope[i] - mean) * (onsetEnvelope[i] - mean);
  let pulseRegularity: number | null = null;
  if (r0 > 0 && maxLag > minLag) {
    let best = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let acc = 0;
      for (let i = 0; i + lag < n; i++) {
        acc += (onsetEnvelope[i] - mean) * (onsetEnvelope[i + lag] - mean);
      }
      const r = acc / r0;
      if (r > best) best = r;
    }
    pulseRegularity = Math.min(1, Math.max(0, best));
  }
  return { onsetDensity, pulseRegularity };
}

/**
 * メロディチャンネル: ボーカルクロマから、スケール適合度と
 * コードトーン比率を測る。ボーカルが実質鳴っていない入力では
 * 全て null（測れないものを測ったことにしない）。
 */
export function extractMelodyFeatures(
  segments: ChordSegment[],
  parsed: (ParsedSeg | null)[],
  melody: NonNullable<GenreChannelInputs["melodyChroma"]>,
  keyRoot: number,
  keyMode: "major" | "minor",
): GenreMelodyFeatures {
  const scale = keyScalePcs(keyRoot, keyMode);
  const fd = melody.frameDuration;
  // 全体のピッチクラス分布（エネルギー加重）
  const dist = new Float32Array(12);
  let totalMass = 0;
  let maxEnergy = 0;
  let activeFrames = 0;
  for (let i = 0; i < melody.frames.length; i++) {
    const e = Math.max(melody.energies[i] ?? 0, 0);
    if (e > maxEnergy) maxEnergy = e;
    totalMass += e;
    for (let p = 0; p < 12; p++) dist[p] += melody.frames[i][p] * e;
  }
  if (totalMass <= 0 || maxEnergy <= 0) {
    return { scaleConformance: null, chordToneRatio: null, activityShare: null };
  }
  for (let i = 0; i < melody.frames.length; i++) {
    if ((melody.energies[i] ?? 0) > 0.05 * maxEnergy) activeFrames += 1;
  }
  let scaleMass = 0;
  let allMass = 0;
  for (let p = 0; p < 12; p++) {
    allMass += dist[p];
    if (scale.has(p)) scaleMass += dist[p];
  }
  const scaleConformance = allMass > 0 ? scaleMass / allMass : null;

  // セグメントごとのコードトーン比率（ボーカル質量で加重）
  let ratioAcc = 0;
  let ratioMass = 0;
  segments.forEach((seg, i) => {
    const p = parsed[i];
    if (!p) return;
    const startIdx = Math.floor(seg.start / fd);
    const endIdx = Math.min(
      melody.frames.length,
      Math.max(startIdx + 1, Math.ceil(seg.end / fd)),
    );
    if (endIdx - startIdx <= 0) return;
    const tones = new Set([
      p.root,
      (p.root + (p.mode === "major" ? 4 : 3)) % 12,
      (p.root + 7) % 12,
    ]);
    let segAll = 0;
    let segTone = 0;
    let segMass = 0;
    for (let f = startIdx; f < endIdx; f++) {
      const e = Math.max(melody.energies[f] ?? 0, 0);
      segMass += e;
      for (let pc = 0; pc < 12; pc++) {
        const v = melody.frames[f][pc] * e;
        segAll += v;
        if (tones.has(pc)) segTone += v;
      }
    }
    if (segAll > 0) {
      ratioAcc += (segTone / segAll) * segMass;
      ratioMass += segMass;
    }
  });
  return {
    scaleConformance,
    chordToneRatio: ratioMass > 0 ? ratioAcc / ratioMass : null,
    activityShare:
      melody.frames.length > 0 ? activeFrames / melody.frames.length : null,
  };
}

/** 音色チャンネル: 4ステムの RMS シェア（揃わない場合は全て null） */
export function extractTimbreFeatures(
  stemRms: GenreChannelInputs["stemRms"],
): GenreTimbreFeatures {
  if (!stemRms) {
    return { bassShare: null, vocalShare: null, drumsShare: null, otherShare: null };
  }
  const total = stemRms.vocals + stemRms.drums + stemRms.bass + stemRms.other;
  if (total <= 0) {
    return { bassShare: null, vocalShare: null, drumsShare: null, otherShare: null };
  }
  return {
    bassShare: stemRms.bass / total,
    vocalShare: stemRms.vocals / total,
    drumsShare: stemRms.drums / total,
    otherShare: stemRms.other / total,
  };
}

/** 特徴量（チャンネル構造）をスコアリング用の平坦な写像にする */
function flattenFeatures(f: GenreFeatures): Record<ScoredFeatureKey, number | null> {
  return {
    ...f.harmony,
    changesPerMinute: f.rhythm.changesPerMinute,
    onsetDensity: f.rhythm.onsetDensity,
    pulseRegularity: f.rhythm.pulseRegularity,
    melodyScaleConformance: f.melody.scaleConformance,
    melodyChordToneRatio: f.melody.chordToneRatio,
    timbreBassShare: f.timbre.bassShare,
    timbreDrumsShare: f.timbre.drumsShare,
  };
}

/**
 * 特徴量からスタイル分布（混合比率）を出す（傾向表へのガウス
 * 類似度の重み付き平均 → softmax）。null の特徴量は全スタイル
 * で除外し、重みを正規化し直す（チャンネルの欠落は欠落として
 * 扱い、推定の材料が減るだけにする）。
 */
export function scoreGenreFeatures(
  features: GenreFeatures,
): { style: GenreStyleId; score: number }[] {
  const flat = flattenFeatures(features);
  const raw = new Map<GenreStyleId, number>();
  for (const style of GENRE_STYLES) {
    const table = GENRE_TENDENCIES[style];
    let acc = 0;
    let wSum = 0;
    for (const key of Object.keys(table) as ScoredFeatureKey[]) {
      const x = flat[key];
      if (x === null || x === undefined) continue;
      const t = table[key];
      const d = (x - t.mu) / t.sigma;
      acc += t.weight * Math.exp(-d * d);
      wSum += t.weight;
    }
    raw.set(style, wSum > 0 ? acc / wSum : 0);
  }
  const temperature = GENRE_CONFIG.softmaxTemperature;
  const exps = GENRE_STYLES.map((s) => Math.exp((raw.get(s) ?? 0) / temperature));
  const sum = exps.reduce((a, b) => a + b, 0);
  const scores = GENRE_STYLES.map((style, i) => ({
    style,
    score: sum > 0 ? exps[i] / sum : 1 / GENRE_STYLES.length,
  }));
  scores.sort((a, b) => b.score - a.score);
  return scores;
}

/**
 * 様式プロファイルを推定する（部品の入口）。セグメント列は
 * 第1段の確定列（第2段の前）を渡す想定で、推定自体はラベルを
 * 変えない。追加チャンネル（channels）は存在する経路だけ渡す:
 * 混合音経路はオンセット包絡のみ、ステム経路はドラム包絡・
 * ボーカルクロマ・ステム RMS も渡せる。
 */
export function estimateGenreProfile(
  segments: ChordSegment[],
  chromaFrames: Float32Array[],
  energies: Float32Array,
  frameDuration: number,
  keyRoot: number,
  keyMode: "major" | "minor",
  durationSec: number,
  channels?: GenreChannelInputs,
): GenreProfile {
  const parsed = parseSegments(segments);
  const { harmony, changesPerMinute } = extractHarmonyFeatures(
    segments,
    parsed,
    chromaFrames,
    energies,
    frameDuration,
    keyRoot,
    keyMode,
    durationSec,
  );

  let rhythm: GenreRhythmFeatures = {
    changesPerMinute,
    onsetDensity: null,
    pulseRegularity: null,
  };
  if (channels?.onsetEnvelope && channels.onsetFrameDuration) {
    const r = extractRhythmFromOnset(
      channels.onsetEnvelope,
      channels.onsetFrameDuration,
      durationSec,
    );
    rhythm = { changesPerMinute, ...r };
  }

  const melody: GenreMelodyFeatures = channels?.melodyChroma
    ? extractMelodyFeatures(segments, parsed, channels.melodyChroma, keyRoot, keyMode)
    : { scaleConformance: null, chordToneRatio: null, activityShare: null };

  const timbre = extractTimbreFeatures(channels?.stemRms);

  const features: GenreFeatures = { harmony, rhythm, melody, timbre };
  const scores = scoreGenreFeatures(features);
  const top = scores[0];
  const second = scores[1];
  return {
    scores,
    top: top.style,
    confidence: top.score,
    margin: second ? top.score - second.score : top.score,
    features,
    channels: {
      harmony: true,
      rhythm: rhythm.onsetDensity !== null,
      melody: melody.scaleConformance !== null,
      timbre: timbre.bassShare !== null,
    },
  };
}

/**
 * 消費部: 分布（混合比率）×親和度表の加重平均から、拡張クラス
 * ごとのシェアしきい値係数を出す。比率がそのまま prior の
 * 混ざり方になる（単一ラベルで切り替えるのではない）。
 */
export function genreExtensionFactors(
  profile: GenreProfile,
): Record<ChordExtension, number> {
  const classes: ChordExtension[] = ["maj7", "7", "m7"];
  const out = {} as Record<ChordExtension, number>;
  for (const ext of classes) {
    let affinity = 0;
    for (const s of profile.scores) {
      affinity += s.score * GENRE_EXTENSION_AFFINITY[s.style][ext];
    }
    const factor = GENRE_CONFIG.factorBase - GENRE_CONFIG.factorSlope * affinity;
    out[ext] = Math.min(
      GENRE_CONFIG.factorMax,
      Math.max(GENRE_CONFIG.factorMin, factor),
    );
  }
  return out;
}

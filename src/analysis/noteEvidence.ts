import { NO_CHORD } from "../lib/notes";
import type { ChordSegment } from "../types";
import { parseChordName } from "./bassCorrection";

/**
 * 音符レベル証拠の基盤モジュール（検証: measurements/notepitch/
 * NOTEPITCH_VERIFICATION.md、統合: NOTEPITCH_INTEGRATION.md）。
 *
 * 役割: 音高検出で得た「音符イベント列」を、既存の判定構造が使える
 * 形の証拠（ピッチクラスシェア／ベース音／オンセット）に変換し、
 * 限定用途の3つの統合（noteBass / noteTension の証人 /
 * noteBoundaries）に供給する。本モジュールは抽出方法（Basic Pitch
 * 等）には依存しない: 入力は音符イベント列そのものであり、製品で
 * ブラウザ推論を載せる場合も、この境界は変わらない。
 *
 * 集計の定義は検証時の Python 実装（scripts/notepitch/chordinfer.py）
 * の移植であり、同一窓で Python と一致することを単体テストで
 * 確認している（noteEvidence.test.ts、Suno Q1／Q4 窓）:
 * - ピッチクラスシェア: 区間と重なる音符を（重なり秒数 × 振幅）で
 *   重み付けし、ピッチクラス別に合算して正規化したもの。
 * - ベース v2: ベースプールの重みをピッチクラス合算した argmax。
 *   v1（最も低い支配音）は低音ゴーストに弱いことが検証で判明し、
 *   既存の低域クロマ集計（aggregateBassDistribution）と同じ統計で
 *   ある v2 を採用した。
 * - ベースプールの上限は検証と同一: 混合音の音符列からは
 *   MIDI 50 以下、bass ステムの音符列からは 60 以下を使う
 *   （検証の BASS_POOL_MAX / REAL_BASS_POOL_MAX）。
 */

export interface NoteEvent {
  /** 開始時刻（秒） */
  start: number;
  /** 終了時刻（秒） */
  end: number;
  /** MIDI ノート番号 */
  pitch: number;
  /** 振幅 0..1（抽出器の信頼度相当） */
  amplitude: number;
}

export interface NoteEvidenceInput {
  /**
   * 和声側の音符列。混合音経路 = 混合音の音符列、
   * ステム経路 = other ステムの音符列。
   */
  harmony: NoteEvent[];
  /** bass ステムの音符列（ステム経路のみ） */
  bass?: NoteEvent[];
  /**
   * 二重確認用の音符列（混合音の音符列。ステム経路でのみ意味を持つ）。
   * noteTension v2（棄権つき証人）が「7 度音の不在」を反証として
   * 使うには、その音が和声プールだけでなくこちらでも不在である
   * ことを要求する（NOTEPITCH_RETRY.md の密度規則の導出参照）。
   * 混合音経路では harmony 自身が混合音プールであり、二重確認は
   * 成立しないため未指定にする（証人は常に棄権する）。
   */
  corroboration?: NoteEvent[];
}

/** ベースプールの上限（混合音の音符列から取る場合。検証 BASS_POOL_MAX） */
export const MIXTURE_BASS_POOL_MAX_PITCH = 50;
/** ベースプールの上限（bass ステムの音符列。検証 REAL_BASS_POOL_MAX） */
export const STEM_BASS_POOL_MAX_PITCH = 60;

/** ベース証拠に使う音符プールを返す（上限で絞った新しい配列） */
export function bassPoolNotes(input: NoteEvidenceInput): NoteEvent[] {
  if (input.bass) {
    return input.bass.filter((n) => n.pitch <= STEM_BASS_POOL_MAX_PITCH);
  }
  return input.harmony.filter((n) => n.pitch <= MIXTURE_BASS_POOL_MAX_PITCH);
}

function overlapWeight(n: NoteEvent, t0: number, t1: number): number {
  const ov = Math.min(n.end, t1) - Math.max(n.start, t0);
  return ov > 0 ? ov * Math.max(n.amplitude, 1e-6) : 0;
}

/**
 * 区間 [t0, t1) のピッチクラスシェア（合計 ≒ 1）。
 * 音符が1つも重ならなければ null（Python pc_shares の移植）。
 */
export function notePcShares(
  notes: NoteEvent[],
  t0: number,
  t1: number,
): Float32Array | null {
  const acc = new Float32Array(12);
  let total = 0;
  for (const n of notes) {
    const w = overlapWeight(n, t0, t1);
    if (w <= 0) continue;
    acc[n.pitch % 12] += w;
    total += w;
  }
  if (total <= 0) return null;
  for (let p = 0; p < 12; p++) acc[p] /= total;
  return acc;
}

/**
 * ピッチクラスごとの被覆率: その音クラスの音符が鳴っている時間
 * （重なり合う音符は和集合で数える）の、区間長に対する割合。
 * 音符ドメインの「持続性」（noteTension の証人用）。
 */
export function notePcCoverage(
  notes: NoteEvent[],
  t0: number,
  t1: number,
): Float32Array {
  const coverage = new Float32Array(12);
  const dur = t1 - t0;
  if (dur <= 0) return coverage;
  const intervals: [number, number][][] = Array.from({ length: 12 }, () => []);
  for (const n of notes) {
    const s = Math.max(n.start, t0);
    const e = Math.min(n.end, t1);
    if (e > s) intervals[n.pitch % 12].push([s, e]);
  }
  for (let p = 0; p < 12; p++) {
    const ivs = intervals[p].sort((a, b) => a[0] - b[0]);
    let covered = 0;
    let curS = -Infinity;
    let curE = -Infinity;
    for (const [s, e] of ivs) {
      if (s > curE) {
        if (curE > curS) covered += curE - curS;
        curS = s;
        curE = e;
      } else if (e > curE) {
        curE = e;
      }
    }
    if (curE > curS) covered += curE - curS;
    coverage[p] = Math.min(1, covered / dur);
  }
  return coverage;
}

export interface NoteBassEvidence {
  /** ベース音のピッチクラス（プールのピッチクラス合算 argmax） */
  topPc: number;
  /** トップのピッチクラスのシェア */
  topShare: number;
  /** トップ − 2位のシェア差 */
  margin: number;
  /** プール音符が区間を覆う割合（和集合、0..1） */
  coverage: number;
}

/**
 * 区間の音符ベース証拠（v2 規則）。プール音符が無ければ null。
 * シェアはピッチクラス合算の重み（重なり秒数 × 振幅）から取る。
 */
export function noteBassEvidence(
  pool: NoteEvent[],
  t0: number,
  t1: number,
): NoteBassEvidence | null {
  const shares = notePcShares(pool, t0, t1);
  if (!shares) return null;
  let topPc = 0;
  let topShare = -1;
  let secondShare = -1;
  for (let p = 0; p < 12; p++) {
    if (shares[p] > topShare) {
      secondShare = topShare;
      topShare = shares[p];
      topPc = p;
    } else if (shares[p] > secondShare) {
      secondShare = shares[p];
    }
  }
  // 被覆率はプール全体（全ピッチクラス）の和集合で測る
  let covered = 0;
  const ivs = pool
    .map((n) => [Math.max(n.start, t0), Math.min(n.end, t1)] as [number, number])
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0]);
  let curS = -Infinity;
  let curE = -Infinity;
  for (const [s, e] of ivs) {
    if (s > curE) {
      if (curE > curS) covered += curE - curS;
      curS = s;
      curE = e;
    } else if (e > curE) {
      curE = e;
    }
  }
  if (curE > curS) covered += curE - curS;
  const dur = t1 - t0;
  return {
    topPc,
    topShare,
    margin: topShare - secondShare,
    coverage: dur > 0 ? Math.min(1, covered / dur) : 0,
  };
}

/**
 * 区間のうち、何らかの音符が鳴っている時間の割合（和集合、0..1）。
 * noteTension v2 の密度ゲート（書き起こしがその窓で機能しているか）
 * に使う。
 */
export function noteUnionCoverage(
  notes: NoteEvent[],
  t0: number,
  t1: number,
): number {
  const dur = t1 - t0;
  if (dur <= 0) return 0;
  const ivs = notes
    .map((n) => [Math.max(n.start, t0), Math.min(n.end, t1)] as [number, number])
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0]);
  let covered = 0;
  let curS = -Infinity;
  let curE = -Infinity;
  for (const [s, e] of ivs) {
    if (s > curE) {
      if (curE > curS) covered += curE - curS;
      curS = s;
      curE = e;
    } else if (e > curE) {
      curE = e;
    }
  }
  if (curE > curS) covered += curE - curS;
  return Math.min(1, covered / dur);
}

/** noteTension の証人（1セグメント分） */
export interface NoteWitness {
  /** 和声音符のピッチクラスシェア */
  shares: Float32Array;
  /** ピッチクラスごとの被覆率（持続性） */
  coverage: Float32Array;
  /** 和声プール全体の和集合被覆率（密度ゲート用、v2 で追加） */
  unionCoverage: number;
  /**
   * 二重確認プール（混合音）のピッチクラスシェア（v2 で追加）。
   * プールが渡されていない、または窓に音符が重ならなければ null。
   */
  corroborationShares: Float32Array | null;
}

/** 区間の証人を組み立てる。音符が重ならなければ null（クロマに委ねる） */
export function noteSegmentWitness(
  harmony: NoteEvent[],
  t0: number,
  t1: number,
  corroboration?: NoteEvent[],
): NoteWitness | null {
  const shares = notePcShares(harmony, t0, t1);
  if (!shares) return null;
  return {
    shares,
    coverage: notePcCoverage(harmony, t0, t1),
    unionCoverage: noteUnionCoverage(harmony, t0, t1),
    corroborationShares: corroboration
      ? notePcShares(corroboration, t0, t1)
      : null,
  };
}

// ---------------------------------------------------------------------------
// noteBass: ベース／分数コードの確定
// ---------------------------------------------------------------------------

export const NOTE_BASS_CONFIG = {
  /** bassPc を補強（新規記録）できる証拠の下限 */
  recordTopShare: 0.3,
  recordCoverage: 0.3,
  /** bassPc の置換と分数確定に要求する強い証拠 */
  strongTopShare: 0.45,
  strongMargin: 0.15,
  strongCoverage: 0.4,
  /** 分数確定: 候補コードの和声シェア説明率の下限 */
  repairMinExplained: 0.7,
  /** 分数確定: 候補 − 現在コードの説明率の差の下限 */
  repairMinAdvantage: 0.1,
} as const;

/** 三和音の構成音が占める音符シェア合計（説明率。書き換え側でも使う） */
export function triadExplained(
  shares: Float32Array,
  root: number,
  mode: "major" | "minor",
): number {
  const third = mode === "major" ? 4 : 3;
  return shares[root] + shares[(root + third) % 12] + shares[(root + 7) % 12];
}

/**
 * 音符証拠による bassPc の確定／付け替え（統合1: noteBass の基本形、
 * v2 で分離）。コード（chord / upperChord / extension）は一切
 * 変更しない。コードの書き換え（修復・昇格）は noteBassRewrite.ts
 * の厳格化した別経路が担う（NOTEPITCH_RETRY.md の再設計参照）。
 *
 * v1（NOTEPITCH_INTEGRATION.md）の機構診断: 実曲回帰の主因は
 * 書き換えであり、bassPc 付け替え単独では毀損は観測されなかった。
 * 本関数はその付け替えだけを切り出したものである:
 *
 * 1. 強い音符ベース証拠（トップシェア ≥ 0.45、マージン ≥ 0.15、
 *    プール被覆率 ≥ 0.4）がある場合、bassPc を音符側のトップで
 *    置換する（Suno Q1 の実測: プールシェアの辛勝では置換しない
 *    水準に置く）。
 * 2. bassPc が無い場合は弱い証拠（≥ 0.3／被覆率 ≥ 0.3）でも
 *    補強として記録する。
 * 3. 層セグメント（upperChord あり）にも付け替えを適用する。
 *    付け替え後の bassPc を前提に層の再読（applyUpperLayerReRead）
 *    が整合する（v1 は昇格・修復が不発の層を無変更としていたが、
 *    それは書き換えと付け替えが一体だったための保護であり、
 *    付け替え単独では層の表示そのものがベース確定の対象である）。
 * 4. N.C.、edited は触らない。
 *
 * 入力は変更せず、新しい配列を返す。
 */
export function applyNoteBassRelabel(
  segments: ChordSegment[],
  input: NoteEvidenceInput,
): ChordSegment[] {
  const pool = bassPoolNotes(input);
  if (pool.length === 0 && input.harmony.length === 0) return segments;
  return segments.map((seg) => {
    if (seg.edited || seg.chord === NO_CHORD) return seg;
    const parsed = parseChordName(seg.chord);
    if (!parsed) return seg;
    const ev = noteBassEvidence(pool, seg.start, seg.end);
    if (!ev) return seg;
    const cfg = NOTE_BASS_CONFIG;
    const strong =
      ev.topShare >= cfg.strongTopShare &&
      ev.margin >= cfg.strongMargin &&
      ev.coverage >= cfg.strongCoverage;
    const recordable =
      ev.topShare >= cfg.recordTopShare && ev.coverage >= cfg.recordCoverage;
    if (!strong && !recordable) return seg;
    if (seg.bassPc !== undefined && seg.bassPc === ev.topPc) return seg;

    const next: ChordSegment = { ...seg };
    if (next.bassPc === undefined) {
      next.bassPc = ev.topPc;
    } else if (strong) {
      next.bassPc = ev.topPc;
    }
    return next;
  });
}

// ---------------------------------------------------------------------------
// noteBoundaries: 境界のオンセットへのスナップ
// ---------------------------------------------------------------------------

export interface NoteOnset {
  time: number;
  /** 同時発音クラスタの振幅合計 */
  strength: number;
  /** クラスタを構成する音符の数（和音のアタック判定に使う） */
  count: number;
}

export const NOTE_BOUNDARY_CONFIG = {
  /** 開始時刻のクラスタ化幅（秒） */
  clusterSec: 0.05,
  /** スナップ先として認めるオンセット強さの下限 */
  minStrength: 1.0,
  /**
   * スナップ先として認める同時発音数の下限。和音の切り替わりは
   * 複数音の同時アタックとして現れるが、ベース単音の拍アクセントは
   * 境界でない位置にも強いオンセットを作る（初回測定で Song D が
   * −1.8pt 悪化した主因）。単音クラスタへのスナップは行わない。
   */
  minCount: 2,
  /** 境界からスナップ先を探す範囲（±秒） */
  snapWindowSec: 0.3,
  /** これ未満の移動はしない（ジッタ防止） */
  minMoveSec: 0.04,
  /** 移動後に両側へ残す最小セグメント長（segmentation.ts と同値） */
  minSegmentSec: 0.35,
} as const;

/**
 * 音符開始時刻のクラスタ列を作る。クラスタ時刻は振幅加重平均、
 * 強さは振幅合計（和音のアタックは複数音の同時開始として現れる）。
 */
export function noteOnsets(notes: NoteEvent[]): NoteOnset[] {
  const sorted = [...notes].sort((a, b) => a.start - b.start);
  const out: NoteOnset[] = [];
  let clusterStart = -Infinity;
  let wSum = 0;
  let tSum = 0;
  let strength = 0;
  let count = 0;
  const flush = () => {
    if (strength > 0) {
      out.push({ time: tSum / wSum, strength, count });
    }
  };
  for (const n of sorted) {
    if (n.start - clusterStart > NOTE_BOUNDARY_CONFIG.clusterSec) {
      flush();
      clusterStart = n.start;
      wSum = 0;
      tSum = 0;
      strength = 0;
      count = 0;
    }
    const w = Math.max(n.amplitude, 1e-6);
    wSum += w;
    tSum += n.start * w;
    strength += n.amplitude;
    count += 1;
  }
  flush();
  return out;
}

/**
 * セグメンテーション境界を強い音符オンセットへ近傍スナップする
 * （統合3: noteBoundaries）。境界決定そのもの（メディアン／
 * マージ／吸収）は変えず、後段の補正として働く。内部の強い
 * オンセットでの新規分割は行わない。入力は変更しない。
 */
export function applyNoteBoundarySnap(
  segments: ChordSegment[],
  onsets: NoteOnset[],
): ChordSegment[] {
  if (segments.length < 2 || onsets.length === 0) return segments;
  const cfg = NOTE_BOUNDARY_CONFIG;
  const out = segments.map((s) => ({ ...s }));
  for (let i = 0; i < out.length - 1; i++) {
    const seg = out[i];
    const next = out[i + 1];
    const b = seg.end;
    let best: NoteOnset | null = null;
    for (const o of onsets) {
      if (o.strength < cfg.minStrength) continue;
      if (o.count < cfg.minCount) continue;
      if (Math.abs(o.time - b) > cfg.snapWindowSec) continue;
      // 境界誤差は局在化の問題なので、窓内の最強オンセットではなく
      // 最近傍の適格オンセットへ寄せる（最強優先だと隣接イベントの
      // アクセントに引っ張られる。初回測定の Song D 悪化の主因）
      if (
        !best ||
        Math.abs(o.time - b) < Math.abs(best.time - b) ||
        (Math.abs(o.time - b) === Math.abs(best.time - b) &&
          o.strength > best.strength)
      ) {
        best = o;
      }
    }
    if (!best) continue;
    const t = Math.round(best.time * 1000) / 1000;
    if (Math.abs(t - b) < cfg.minMoveSec) continue;
    if (t - seg.start < cfg.minSegmentSec) continue;
    if (next.end - t < cfg.minSegmentSec) continue;
    seg.end = t;
    next.start = t;
  }
  return out;
}

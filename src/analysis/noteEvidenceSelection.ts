import { notePcShares, type NoteEvent } from "./noteEvidence";

/**
 * 音符レベルの証拠選択（診断と設計根拠:
 * measurements/notepitch/EVIDENCE_SELECTION.md）。
 *
 * 役割: 音高検出で得た音符イベント列から、「和声証拠として
 * 使える部分」だけを選び出し、セグメント単位の選択済み和声
 * 証拠（ピッチクラス重み＋出自）を返す。Theory Engine 第2段の
 * 剖検（THEORY_ENGINE_STEP2_RETRY.md §5）が特定した拘束条件
 * 「接戦で上帯域集計と複合判定のどちらが正しいかを言い当てる
 * 第三の証拠が現行入力に存在しない」に対し、音符レベルの
 * 証拠を独立した第三の証拠として成立させるための上流モジュール。
 * 本モジュールは消費者を持たない（パイプライン未接続）。
 * 既存の消費者（noteBass 等）は一切触らない。
 *
 * 実曲で生の音符証拠が壊れる主因はメロディ汚染（ボーカル等の
 * 旋律音がコードトーンとして数えられる）と短い装飾音・経過音の
 * 混入であり、本モジュールは次の2機構で対処する:
 *
 * 1. 持続音の重み付け: 音符の重みに持続係数
 *    min(1, 全長 / SUSTAIN_REF_SEC) を掛ける。和声音はコードの
 *    持続中鳴り続ける（1拍以上が典型）のに対し、装飾音・経過音
 *    は拍未満で通過する、という非対称を使う。SUSTAIN_REF_SEC =
 *    0.5 秒は対象レパートリーのテンポ帯（90〜140 BPM）での
 *    「1拍」の代表値であり、テンポ盲検のヒューリスティクス
 *    であることを明記する。
 * 2. メロディライン分離: 音符イベントだけから最上声部
 *    （skyline）を推定し、旋律分類された音符を和声証拠から
 *    除外する。音符 n の topFraction（鳴っている間に n より
 *    高い音が鳴っていない時間の割合）が 0.5 以上なら旋律と
 *    する。入力に旋律ステムの音符列（vocals）が別途ある場合は、
 *    同一ピッチで十分に重なる和声音符も旋律分類する。
 *    skyline は「旋律」と「ボイシングのトップ」を原理的に
 *    区別できない（既知の限界）。そのため §フォールバックで
 *    証拠の全損だけは防ぐ。
 *
 * フォールバック（消費側への契約「選択は証拠を壊さない」）:
 * メロディ分離が有効なセグメントで、選択後の総重みが原重みの
 * FALLBACK_MIN_SHARE 未満になった場合、そのセグメントは
 * 原音符証拠（notePcShares）にフォールバックし、provenance に
 * 記録する。単旋律だけの楽節（全音符が最上声部）などで証拠が
 * 消えることを防ぐ。
 *
 * 両機構を OFF にした出力は notePcShares と一致する
 * （単体テストで固定）。集計の土台（重なり秒数 × 振幅）は
 * noteEvidence.ts の定義と同一であり、抽出手段には依存しない。
 */

export interface NoteSelectionInput {
  /** 和声側の音符列（混合音経路 = 混合音、ステム経路 = other） */
  harmony: NoteEvent[];
  /**
   * 旋律ステムの音符列（ボーカル等。ステム経路でボーカルが
   * 別チャンネルとして与えられる場合のみ）。和声プールの音符が
   * これと同一ピッチで十分に重なれば旋律分類される。
   */
  vocals?: NoteEvent[];
}

export interface NoteSelectionOptions {
  /** 持続音の重み付けを使うか（既定: true） */
  sustainWeighting?: boolean;
  /** メロディライン分離を使うか（既定: true） */
  melodySeparation?: boolean;
  /** 持続係数の基準秒数（既定: NOTE_SELECTION_CONFIG.sustainRefSec） */
  sustainRefSec?: number;
  /** 旋律分類の topFraction 下限（既定: 同 config） */
  melodyTopFraction?: number;
  /** フォールバックの下限シェア（既定: 同 config） */
  fallbackMinShare?: number;
}

export const NOTE_SELECTION_CONFIG = {
  /** 持続係数の基準（秒）。これ以上の長さの音符は係数 1 */
  sustainRefSec: 0.5,
  /** 旋律分類: 生涯のこの割合以上、最上声部にいたら旋律 */
  melodyTopFraction: 0.5,
  /** ボーカル照合: 短い方の音符長に対する重なりの下限割合 */
  vocalOverlapFraction: 0.5,
  /** フォールバック: 選択後の総重みが原重みのこの割合未満なら原証拠へ */
  fallbackMinShare: 0.1,
} as const;

/** 持続係数: min(1, 全長 / refSec)。長さ 0 以下は 0 */
export function sustainFactor(durationSec: number, refSec: number): number {
  if (!(durationSec > 0) || !(refSec > 0)) return 0;
  return Math.min(1, durationSec / refSec);
}

/**
 * 音符列の旋律マスクを返す（入力と同じ順序・長さ。true = 旋律）。
 *
 * skyline: 各音符について「自分より高い音が鳴っていない時間」を
 * [start, end) の中で測り、その割合（topFraction）が下限以上なら
 * 旋律とする。同ピッチの重なりは「より高い音」に数えない。
 * vocals が与えられた場合は、同一ピッチで短い方の
 * vocalOverlapFraction 以上重なるボーカル音符がある和声音符も
 * 旋律とする（OR 条件）。
 */
export function classifyMelodyNotes(
  notes: NoteEvent[],
  options?: {
    topFractionMin?: number;
    vocals?: NoteEvent[];
  },
): boolean[] {
  const minFrac =
    options?.topFractionMin ?? NOTE_SELECTION_CONFIG.melodyTopFraction;
  const vocals = options?.vocals;
  // 開始時刻順のインデックス（重なり探索の早期打ち切り用）
  const byStart = notes
    .map((n, i) => ({ n, i }))
    .sort((a, b) => a.n.start - b.n.start);
  const mask = new Array<boolean>(notes.length).fill(false);

  for (let idx = 0; idx < byStart.length; idx++) {
    const { n, i } = byStart[idx];
    const dur = n.end - n.start;
    let isMelody = false;
    if (dur > 0) {
      // n より高い音との重なり区間の和集合長を測る
      const ivs: [number, number][] = [];
      for (let j = 0; j < byStart.length; j++) {
        const m = byStart[j].n;
        if (m.start >= n.end) break;
        if (m.pitch <= n.pitch) continue;
        const s = Math.max(m.start, n.start);
        const e = Math.min(m.end, n.end);
        if (e > s) ivs.push([s, e]);
      }
      ivs.sort((a, b) => a[0] - b[0]);
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
      const topFraction = 1 - covered / dur;
      isMelody = topFraction >= minFrac;
    }
    if (!isMelody && vocals && vocals.length > 0) {
      for (const v of vocals) {
        if (v.pitch !== n.pitch) continue;
        const ov = Math.min(v.end, n.end) - Math.max(v.start, n.start);
        if (ov <= 0) continue;
        const shorter = Math.min(v.end - v.start, dur);
        if (shorter > 0 && ov >= NOTE_SELECTION_CONFIG.vocalOverlapFraction * shorter) {
          isMelody = true;
          break;
        }
      }
    }
    mask[i] = isMelody;
  }
  return mask;
}

/** 選択済み和声証拠の出自（セグメント単位） */
export interface SegmentEvidenceProvenance {
  /** 区間に重なる音符の数 */
  noteCount: number;
  /** そのうち旋律分類された音符の数 */
  melodyNoteCount: number;
  /** 原重み: 全音符の（重なり秒数 × 振幅）合計 */
  rawWeight: number;
  /** 選択後の総重み（正規化前。フォールバック時は原重みと同値） */
  selectedWeight: number;
  /** 原重みのうち旋律分類音符が占める割合（0..1） */
  melodyWeightShare: number;
  /** フォールバックが発動したか */
  fallback: boolean;
}

export interface SelectedSegmentEvidence {
  start: number;
  end: number;
  /** 選択済みピッチクラス重み（合計 ≒ 1。証拠が無ければ null） */
  pcWeights: Float32Array | null;
  provenance: SegmentEvidenceProvenance;
}

interface IntervalWeights {
  weights: Float32Array | null;
  provenance: SegmentEvidenceProvenance;
}

/**
 * 1 区間の選択済み証拠を計算する（内部実装）。
 * melodyMask は notes と同じ順序の旋律マスク（classifyMelodyNotes
 * の出力）。options の機構 OFF は診断の条件切り替え用であり、
 * 両方 OFF のとき結果は notePcShares と一致する。
 */
export function segmentSelectedWeights(
  notes: NoteEvent[],
  melodyMask: boolean[],
  t0: number,
  t1: number,
  options?: NoteSelectionOptions,
): IntervalWeights {
  const useSustain = options?.sustainWeighting !== false;
  const useMelody = options?.melodySeparation !== false;
  const refSec = options?.sustainRefSec ?? NOTE_SELECTION_CONFIG.sustainRefSec;
  const fallbackMin =
    options?.fallbackMinShare ?? NOTE_SELECTION_CONFIG.fallbackMinShare;

  const acc = new Float32Array(12);
  let rawWeight = 0;
  let melodyWeight = 0;
  let selectedWeight = 0;
  let noteCount = 0;
  let melodyNoteCount = 0;
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    const ov = Math.min(n.end, t1) - Math.max(n.start, t0);
    if (ov <= 0) continue;
    const base = ov * Math.max(n.amplitude, 1e-6);
    noteCount++;
    rawWeight += base;
    const isMelody = melodyMask[i] === true;
    if (isMelody) {
      melodyNoteCount++;
      melodyWeight += base;
    }
    if (useMelody && isMelody) continue;
    const w = useSustain ? base * sustainFactor(n.end - n.start, refSec) : base;
    acc[n.pitch % 12] += w;
    selectedWeight += w;
  }
  const provenance: SegmentEvidenceProvenance = {
    noteCount,
    melodyNoteCount,
    rawWeight,
    selectedWeight,
    melodyWeightShare: rawWeight > 0 ? melodyWeight / rawWeight : 0,
    fallback: false,
  };
  if (rawWeight <= 0) {
    return { weights: null, provenance };
  }
  // フォールバック: メロディ分離で証拠がほぼ全損したら原証拠へ。
  // 「選択は証拠を壊さない」ための安全弁（単旋律だけの楽節等）。
  if (useMelody && selectedWeight < fallbackMin * rawWeight) {
    provenance.fallback = true;
    provenance.selectedWeight = rawWeight;
    return { weights: notePcShares(notes, t0, t1), provenance };
  }
  if (selectedWeight <= 0) {
    return { weights: null, provenance };
  }
  for (let p = 0; p < 12; p++) acc[p] /= selectedWeight;
  return { weights: acc, provenance };
}

/**
 * セグメント列に対する選択済み和声証拠を返す。旋律マスクは
 * 和声プール全体に対して1回だけ計算する（セグメントをまたぐ
 * 音符の topFraction を正しく測るため）。入力は変更しない。
 */
export function selectSegmentEvidence(
  segments: readonly { start: number; end: number }[],
  input: NoteSelectionInput,
  options?: NoteSelectionOptions,
): SelectedSegmentEvidence[] {
  const useMelody = options?.melodySeparation !== false;
  const mask = useMelody
    ? classifyMelodyNotes(input.harmony, {
        topFractionMin: options?.melodyTopFraction,
        vocals: input.vocals,
      })
    : input.harmony.map(() => false);
  return segments.map((seg) => {
    const { weights, provenance } = segmentSelectedWeights(
      input.harmony,
      mask,
      seg.start,
      seg.end,
      options,
    );
    return { start: seg.start, end: seg.end, pcWeights: weights, provenance };
  });
}

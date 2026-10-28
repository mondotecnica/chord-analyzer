import { chordName, NO_CHORD } from "../lib/notes";
import type { ChordSegment } from "../types";
import { parseChordName } from "./bassCorrection";
import {
  segmentEvidence,
  triadTemplateFit,
} from "./extensionDetection";
import {
  bassPoolNotes,
  noteBassEvidence,
  notePcShares,
  NOTE_BASS_CONFIG,
  triadExplained,
  type NoteEvidenceInput,
} from "./noteEvidence";

/**
 * noteBass v2: 厳格化したコード書き換え（修復・昇格）の別経路
 * （NOTEPITCH_RETRY.md の再設計、noteBassRewrite サブオプション）。
 *
 * v1（applyNoteBass に一体だった形）の機構診断で、実曲回帰の主因は
 * この書き換えだった。本モジュールは書き換えを付け替え
 * （applyNoteBassRelabel）から分離し、次の全てを満たす場合にだけ
 * 許可する:
 *
 * 1. v1 の音符側条件: 強い音符ベース証拠（NOTE_BASS_CONFIG の
 *    strong 閾値）があり、候補コードの和声シェア説明率が 0.70 以上、
 *    現在コードへの説明率優位が 0.10 以上。
 * 2. 二重証拠: 呼び出し側が渡すクロマ証拠（stems 経路では層再読と
 *    同じ other 全帯域クロマ）のセグメント集計でも、候補の三和音
 *    適合度が現在コードを NOTE_BASS_REWRITE_CONFIG.
 *    minChromaFitAdvantage（0.06、層ゲートの分離定数と同水準）
 *    以上上回ること。音符側の説明率は混合音や旋律線の混入で
 *    誤候補が高くなり得るが（v1 の敗因）、エネルギー加重のクロマ
 *    集計は持続音に重みが寄るため同じ誤り方をしない。独立した
 *    2系統の一致を要求することで、片系の誤発火を止める。
 * 3. 経路の限定: 呼び出しは stems 経路（analyzeStems）からのみ。
 *    混合音経路では本関数自体が呼ばれない（書き換え禁止）。
 * 4. 層の保全: upperExtension を持つ層セグメントは昇格しない。
 *    v1 では昇格が層再読を先取りし、Suno Q4 の表示が CM7/C# から
 *    Em に後退した。拡張を持つ層は、本体化すると層表示の情報
 *    （上層の拡張）が失われるため、再読に委ねる。
 *
 * 対象は v1 と同じ2形:
 * - 昇格: bassCorrection 由来の層（upperChord あり）について、
 *   音符ベースが一致し upperChord が現在コードを大きく上回れば、
 *   upperChord をコード本体へ昇格させる（bassPc は音符ベースに
 *   確定し、upperChord は落とす）。
 * - 修復（分数確定）: 検出ルートが音符ベース音と一致（ベース音へ
 *   潰れた形）し、ベース音を 3rd／5th に持つ別ルート候補が
 *   現在コードを大きく上回れば、その候補をコードとして確定する。
 *
 * N.C.、edited は触らない。入力は変更せず、新しい配列を返す。
 */

export const NOTE_BASS_REWRITE_CONFIG = {
  /**
   * 二重証拠: 候補 − 現在コードのクロマ三和音適合度の差の下限。
   * 層の実在ゲートの分離定数（LAYER_GATE_CONFIG.minFitGap = 0.06、
   * 真の層と誤読を分けた実測水準）と揃える。
   */
  minChromaFitAdvantage: 0.06,
} as const;

/** 書き換えの二重証拠に使うクロマ（呼び出し側が経路の証拠帯域を渡す） */
export interface NoteBassChromaEvidence {
  frames: Float32Array[];
  energies: Float32Array;
  frameDuration: number;
}

export function applyNoteBassRewrite(
  segments: ChordSegment[],
  input: NoteEvidenceInput,
  chroma: NoteBassChromaEvidence,
): ChordSegment[] {
  const pool = bassPoolNotes(input);
  if (pool.length === 0 && input.harmony.length === 0) return segments;
  const cfg = NOTE_BASS_CONFIG;
  return segments.map((seg) => {
    if (seg.edited || seg.chord === NO_CHORD) return seg;
    const parsed = parseChordName(seg.chord);
    if (!parsed) return seg;
    const ev = noteBassEvidence(pool, seg.start, seg.end);
    if (!ev) return seg;
    const strong =
      ev.topShare >= cfg.strongTopShare &&
      ev.margin >= cfg.strongMargin &&
      ev.coverage >= cfg.strongCoverage;
    if (!strong) return seg;
    const B = ev.topPc;

    const shares = notePcShares(input.harmony, seg.start, seg.end);
    if (!shares) return seg;
    const currentExplained = triadExplained(shares, parsed.root, parsed.mode);

    // 二重証拠用のクロマ集計（層再読と同じ segmentEvidence）
    const startIdx = Math.floor(seg.start / chroma.frameDuration);
    const endIdx = Math.max(
      startIdx + 1,
      Math.ceil(seg.end / chroma.frameDuration),
    );
    const cev = segmentEvidence(chroma.frames, chroma.energies, startIdx, endIdx);
    if (!cev) return seg;
    const currentFit = triadTemplateFit(cev.shares, parsed.root, parsed.mode);
    const chromaBacks = (root: number, mode: "major" | "minor"): boolean =>
      triadTemplateFit(cev.shares, root, mode) - currentFit >=
      NOTE_BASS_REWRITE_CONFIG.minChromaFitAdvantage;

    const next: ChordSegment = { ...seg };

    // 昇格（層セグメント）: upperExtension を持つ層は保全のため対象外
    if (seg.upperChord !== undefined && seg.upperExtension === undefined) {
      const bassAgrees = seg.bassPc === undefined || seg.bassPc === B;
      const upper = parseChordName(seg.upperChord);
      if (bassAgrees && upper && upper.root !== parsed.root) {
        const upperExplained = triadExplained(shares, upper.root, upper.mode);
        if (
          upperExplained >= cfg.repairMinExplained &&
          upperExplained - currentExplained >= cfg.repairMinAdvantage &&
          chromaBacks(upper.root, upper.mode)
        ) {
          next.chord = seg.upperChord;
          next.bassPc = B;
          delete next.upperChord;
          return next;
        }
      }
    }

    // 修復（分数確定）: 検出ルートがベース音に潰れている場合
    if (parsed.root === B) {
      const candidates: { root: number; mode: "major" | "minor" }[] = [
        { root: (B - 4 + 12) % 12, mode: "major" }, // B が長3度
        { root: (B - 3 + 12) % 12, mode: "minor" }, // B が短3度
        { root: (B - 7 + 12) % 12, mode: "major" }, // B が5度（長）
        { root: (B - 7 + 12) % 12, mode: "minor" }, // B が5度（短）
      ];
      let best: { root: number; mode: "major" | "minor"; explained: number } | null =
        null;
      for (const c of candidates) {
        const explained = triadExplained(shares, c.root, c.mode);
        if (!best || explained > best.explained) best = { ...c, explained };
      }
      if (
        best &&
        best.explained >= cfg.repairMinExplained &&
        best.explained - currentExplained >= cfg.repairMinAdvantage &&
        chromaBacks(best.root, best.mode)
      ) {
        next.chord = chordName(best.root, best.mode);
        next.bassPc = B;
        delete next.upperChord;
        return next;
      }
    }

    return seg;
  });
}

import type { ChordSegment } from "../types";
import { parseChordName } from "./bassCorrection";
import {
  EXTENSION_CONFIG,
  segmentEvidence,
  type SegmentEvidence,
} from "./extensionDetection";

/**
 * Phase 3.2: 付加音（add9）の証拠検出（PHASE3_PLAN.md §3.1 の
 * 「9th／add9 は 3.2 と合わせて次に」を受けるモジュール）。
 *
 * - 対象は「7th を伴わないコードに付く 9th」だけ（add9）。
 *   7th がある場合はその音は 9th であり表記体系が異なるため、
 *   対象コード（upperChord があれば上層、無ければ chord）に
 *   7th 拡張（upperExtension / extension）が付いているセグメントは
 *   対象外にする。
 * - 証拠は第2段と同じ上帯域クロマのセグメント集計
 *   （segmentEvidence）。9th 音ピッチクラス（ルート＋長2度）の
 *   シェアと持続性が床を超えた場合にだけ addTones: ["add9"] を付ける。
 *   あわせて 3.3 の maj7 文脈 prior と同じ考え方で、その音が曲の
 *   他のコード区間でも同程度に鳴っている量（背景シェア）を
 *   割り引く。実曲の other ステムにはメロディラインが含まれ、
 *   9th 音はメロディとして頻出するため、生シェアだけでは
 *   実曲で誤発火が多発した（PHASE3_2_RESULTS.md の実測）。
 * - 9th 音がベース音そのものの場合（例: C/D の D）は付加音ではなく
 *   ベース層の音なので付けない（分数表示側で表される）。
 * - chord / extension / upperChord / upperExtension / bassPc は
 *   一切変更しない。付けるのは addTones フィールドのみ。
 * - 拡張音検出（extensions）有効時のみ呼ばれる（第2段と同じ
 *   オプトイン。テンション語彙の判定は既定 OFF のまま、という
 *   Phase 3.1 の採用方針を維持する）。N.C. と edited は対象外。
 */
export const ADD_TONE_CONFIG = {
  /**
   * 9th 音ピッチクラスのシェア下限（セグメント平均、上帯域クロマ。
   * 背景割り引き後のシェアと、生シェアの両方に課す）。
   * 根拠（PHASE3_2_RESULTS.md の分布実測）: 合成の三和音対照
   * （Song A–F＋G の対照小節）の生シェアは最大 0.094（5 度音の
   * 3 倍音が 9th として現れる床）、Song G の真の add9 は
   * ストラムを含むセグメントで 0.135〜0.195。アルペジオだけの
   * セグメントでは真の add9 でも 0.05 程度まで落ち、倍音の床と
   * 分離できない（測定上の限界として結果文書に明記）。
   * その中間で、かつ実曲の誤発火を背景割り引きと併せて
   * 落とせる位置として 0.11。
   */
  minAdd9Share: 0.11,
  /** 持続性の下限（第2段の EXTENSION_CONFIG.minPersistence と同値） */
  minPersistence: EXTENSION_CONFIG.minPersistence,
  /**
   * 背景シェアの割り引き係数（3.3 の maj7 文脈 prior と同じ 0.5）。
   * 背景シェア = 対象ルートと異なり、その音が三和音構成音でもない
   * セグメント群でのシェア中央値（extensionDetection の
   * backgroundShare と同じ定義を、対象コード列に対して適用）。
   */
  backgroundDiscount: 0.5,
  /**
   * 対象セグメントの最小長（秒）。これより短いセグメントは前後の
   * コードの滲みで証拠が汚染されやすく、付加音を主張しない
   * （実例: Suno Q3 の 0.38 秒の C セグメントに次区間の影響で
   * add9 が誤って付いた。PHASE3_2_RESULTS.md）。
   */
  minSegmentSec: 0.5,
} as const;

/** 三和音の構成音ピッチクラス（背景シェアの集計で「その音が構成音の区間」を除くため） */
function triadTones(root: number, mode: "major" | "minor"): number[] {
  return [root, (root + (mode === "major" ? 4 : 3)) % 12, (root + 7) % 12];
}

function medianOf(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/** pc の背景シェア（対象コード列に対する extensionDetection.backgroundShare と同じ定義） */
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

export function applyAddTones(
  segments: ChordSegment[],
  upperBandFrames: Float32Array[],
  energies: Float32Array,
  frameDuration: number,
): ChordSegment[] {
  // 背景シェアの計算のため、全セグメントの証拠と対象コードを先に集める
  const targets = segments.map((seg) =>
    parseChordName(seg.upperChord !== undefined ? seg.upperChord : seg.chord),
  );
  const evidences = segments.map((seg, i) => {
    if (seg.edited || !targets[i]) return null;
    const startIdx = Math.floor(seg.start / frameDuration);
    const endIdx = Math.max(startIdx + 1, Math.ceil(seg.end / frameDuration));
    return segmentEvidence(upperBandFrames, energies, startIdx, endIdx);
  });

  return segments.map((seg, i) => {
    if (seg.edited) return seg;
    if (seg.end - seg.start < ADD_TONE_CONFIG.minSegmentSec) return seg;
    const useUpper = seg.upperChord !== undefined;
    const targetExt = useUpper ? seg.upperExtension : seg.extension;
    if (targetExt !== undefined) return seg; // 7th がある音は 9th であり add9 ではない
    const parsed = targets[i];
    const ev = evidences[i];
    if (!parsed || !ev) return seg; // N.C. は対象外
    const ninthPc = (parsed.root + 2) % 12;
    if (
      seg.bassPc !== undefined &&
      ((seg.bassPc % 12) + 12) % 12 === ninthPc
    ) {
      return seg; // ベース層の音は付加音として数えない
    }
    if (ev.shares[ninthPc] < ADD_TONE_CONFIG.minAdd9Share) return seg;
    if (ev.persistence[ninthPc] < ADD_TONE_CONFIG.minPersistence) return seg;
    const background = backgroundShare(ninthPc, parsed.root, targets, evidences);
    const discounted =
      ev.shares[ninthPc] - ADD_TONE_CONFIG.backgroundDiscount * background;
    if (discounted < ADD_TONE_CONFIG.minAdd9Share) return seg;
    return { ...seg, addTones: ["add9"] as ChordSegment["addTones"] };
  });
}

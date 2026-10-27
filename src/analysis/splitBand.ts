import { chordName } from "../lib/notes";
import type { ChordSegment } from "../types";
import { chordChromaScore, parseChordName } from "./bassCorrection";

/**
 * Phase 1.5: 帯域分業（split）のモード決め直しステップ。
 *
 * 背景（measurements/PHASE1_STEP3.md）: 実曲では全帯域クロマが
 * major → minor の系統的反転を起こす（三和音正解率 1.3%）一方、
 * 上帯域 260Hz はモード反転をほぼ治すが（三和音 51.2%）、ルートを
 * 決める低域の手がかりを捨てるためルートが悪化した（43.6%、
 * 全帯域＋ベース補正の 54.1% に対して）。分業はこの両取りを狙う:
 *
 * - ルート: 全帯域クロマのフレーム判定＋ベース補正（bassCorrection.ts）
 *   で決める。「bass」設定と同一手順・同一しきい値。ここは触らない。
 * - モード: ルートが確定した後、セグメント単位で上帯域クロマの
 *   セグメント平均と、そのルートの major / minor テンプレートの
 *   一致度（コサイン類似度）の高い方に決め直す。本モジュールの担当。
 *
 * 決め直しの規則（再現可能な形で明記する）:
 * - 対象は N.C. でないセグメントのみ。N.C. 判定とセグメント境界と
 *   信頼度は分業では変えない（信頼度は全帯域フレーム判定由来のまま。
 *   モードを反転させても信頼度は再計算しない、という割り切り）。
 * - 上帯域クロマに証拠が無い場合（major / minor 両スコアとも 0、
 *   例: セグメントの音響内容が全てカットオフ未満）は決め直さず、
 *   全帯域側のモードを維持する。引き分け（両スコア同点）の場合も同様。
 * - 両帯域の不一致が強い場合の特別なゲートは置かない。分業の仮説
 *   そのものが「モードは上帯域を信じる」ことであり、ここに条件を
 *   足すと測定の解釈が濁るため（PHASE1_5_HYBRID.md の測定で検証する）。
 * - bassPc（分数コード用の別フィールド）はそのまま保持する。
 *   モードが変われば構成音との関係は変わるが、表示名の組み立ては
 *   表示側（lib/chordDisplay.ts）が都度行うため、ここでは触らない。
 * - 補正はセグメント単位のみ（フレーム単位の書き換えはしない。
 *   segmentation と競合させないための Phase 1 以来の方針）。
 */

/**
 * 上帯域クロマのセグメント平均から、ルート固定でのモードを返す。
 * 証拠が無い／引き分けの場合は null（＝現状のモードを維持せよ）。
 */
export function modeForRootFromBand(
  chromaFrames: Float32Array[],
  energies: Float32Array,
  startIdx: number,
  endIdx: number,
  root: number,
): "major" | "minor" | null {
  const majorScore = chordChromaScore(
    chromaFrames,
    energies,
    startIdx,
    endIdx,
    root,
    "major",
  );
  const minorScore = chordChromaScore(
    chromaFrames,
    energies,
    startIdx,
    endIdx,
    root,
    "minor",
  );
  if (majorScore <= 0 && minorScore <= 0) return null;
  if (majorScore === minorScore) return null;
  return majorScore > minorScore ? "major" : "minor";
}

/**
 * セグメント列のモードだけを上帯域クロマで決め直した新しい配列を返す
 * （入力は変更しない）。ルート・境界・信頼度・bassPc は一切変えない。
 *
 * upperChromaFrames は analyze.ts が chordBand で計算したコード判定用
 * クロマ（chordFrames）を渡す想定。帯域が null の場合は全帯域クロマが
 * そのまま渡ってくるため、決め直しは「全帯域セグメント平均での
 * モード再判定」に帰着する（分業の効果は消える。呼び出し側の責任）。
 */
export function applyUpperBandMode(
  segments: ChordSegment[],
  upperChromaFrames: Float32Array[],
  energies: Float32Array,
  frameDuration: number,
): ChordSegment[] {
  return segments.map((seg) => {
    const parsed = parseChordName(seg.chord);
    if (!parsed) return seg; // N.C. は対象外
    const startIdx = Math.floor(seg.start / frameDuration);
    const endIdx = Math.max(startIdx + 1, Math.ceil(seg.end / frameDuration));
    const mode = modeForRootFromBand(
      upperChromaFrames,
      energies,
      startIdx,
      endIdx,
      parsed.root,
    );
    if (mode === null || mode === parsed.mode) return seg;
    return { ...seg, chord: chordName(parsed.root, mode) };
  });
}

import { NOTE_NAMES, noteName, NO_CHORD } from "./notes";
import type { ChordExtension } from "../types";

/**
 * コード表示名の組み立て（Phase 1 Step 2: 分数コード表示）。
 *
 * 解析コアはコード名（ルート＋モード）とベース音（bassPc）を別フィールドで
 * 保持し、分数表記はここで組み立てる（PHASE1_PLAN.md セクション 3）。
 * この関数は表示専用の純粋関数で、解析結果そのものは変更しない。
 *
 * ルール:
 * - ベース音が無い、またはルートと同じ → 通常表示（例: "C"）
 * - ベース音がルートと異なり、かつ三和音の構成音（3rd / 5th）
 *   → 分数表示（例: "C/E"、"Am/E"）
 * - ベース音が構成音でない → 通常表示のまま。
 *   その場合は Step 1 のルート補正の対象領域であり、表示側では扱わない。
 */

function parseChord(
  chord: string,
): { root: number; mode: "major" | "minor" } | null {
  if (chord === NO_CHORD) return null;
  if (chord.endsWith("m")) {
    const root = NOTE_NAMES.indexOf(
      chord.slice(0, -1) as (typeof NOTE_NAMES)[number],
    );
    return root >= 0 ? { root, mode: "minor" } : null;
  }
  const root = NOTE_NAMES.indexOf(chord as (typeof NOTE_NAMES)[number]);
  return root >= 0 ? { root, mode: "major" } : null;
}

/** 3rd（major: +4 / minor: +3）または 5th（+7）かどうか */
export function isChordToneBass(
  root: number,
  mode: "major" | "minor",
  bassPc: number,
): boolean {
  const interval = (((bassPc - root) % 12) + 12) % 12;
  const third = mode === "major" ? 4 : 3;
  return interval === third || interval === 7;
}

/**
 * 三和音コア＋拡張音から完全なコード名を組み立てる（Phase 3.1）。
 * - major + maj7 → "CM7" / major + "7" → "C7" / minor + m7 → "Am7"
 * - 組み合わせが語彙外（major + m7、minor + maj7 等）の場合は
 *   拡張を付けずコアのまま返す（第2段はそのような組み合わせを出さない）。
 */
export function fullChordName(chord: string, extension?: ChordExtension): string {
  if (extension === undefined) return chord;
  const parsed = parseChord(chord);
  if (!parsed) return chord;
  if (parsed.mode === "major" && extension === "maj7") return `${chord}M7`;
  if (parsed.mode === "major" && extension === "7") return `${chord}7`;
  if (parsed.mode === "minor" && extension === "m7") return `${chord}7`;
  return chord;
}

/**
 * コード名とベース音ピッチクラスから表示名を組み立てる。
 * extension がある場合は完全名（例: "B7"）を組み立ててから分数判定をする。
 * 分数表示の条件は従来通り三和音コアの構成音（3rd / 5th）で判定する
 * （7th 音をベースにする転回形の層表示は Phase 3.2 の範囲）。
 */
export function displayChordName(
  chord: string,
  bassPc?: number,
  extension?: ChordExtension,
): string {
  const full = fullChordName(chord, extension);
  if (bassPc === undefined) return full;
  const parsed = parseChord(chord);
  if (!parsed) return full;
  const bass = ((bassPc % 12) + 12) % 12;
  if (bass === parsed.root) return full;
  if (!isChordToneBass(parsed.root, parsed.mode, bass)) return full;
  return `${full}/${noteName(bass)}`;
}

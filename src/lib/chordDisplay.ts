import { NOTE_NAMES, noteName, NO_CHORD } from "./notes";

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

/** コード名とベース音ピッチクラスから表示名を組み立てる */
export function displayChordName(chord: string, bassPc?: number): string {
  if (bassPc === undefined) return chord;
  const parsed = parseChord(chord);
  if (!parsed) return chord;
  const bass = ((bassPc % 12) + 12) % 12;
  if (bass === parsed.root) return chord;
  if (!isChordToneBass(parsed.root, parsed.mode, bass)) return chord;
  return `${chord}/${noteName(bass)}`;
}

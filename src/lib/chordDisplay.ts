import {
  noteNameSpelled,
  parseNoteName,
  NO_CHORD,
  type SpellingFamily,
} from "./notes";
import type { ChordExtension, ChordSegment } from "../types";

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

/** コード名（"Am" 等）→ ルートとモード。N.C. と解釈できない名前は null（lib/degrees.ts からも使う） */
export function parseChord(
  chord: string,
): { root: number; mode: "major" | "minor" } | null {
  if (chord === NO_CHORD) return null;
  // ルートの解釈は ♯ 系・♭ 系の両スペルを受ける（移調表示が ♭ 系
  // スペルのラベルを出すため。解析ラベル自体は従来通り ♯ 系のみ）。
  if (chord.endsWith("m")) {
    const root = parseNoteName(chord.slice(0, -1));
    return root !== null ? { root, mode: "minor" } : null;
  }
  const root = parseNoteName(chord);
  return root !== null ? { root, mode: "major" } : null;
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
 * 分数表示の条件は従来通り三和音コアの構成音（3rd / 5th）で判定する。
 * 層表示（Phase 3.2）を含む組み立ては displaySegmentChord が担い、
 * 本関数は層フィールドを持たない呼び出し（履歴測定・単体テスト）用に
 * displaySegmentChord へ委譲する薄いラッパとして残す。
 */
export function displayChordName(
  chord: string,
  bassPc?: number,
  extension?: ChordExtension,
  family: SpellingFamily = "sharps",
): string {
  return displaySegmentChord(
    {
      id: 0,
      start: 0,
      end: 0,
      chord,
      confidence: 0,
      ...(bassPc !== undefined ? { bassPc } : {}),
      ...(extension !== undefined ? { extension } : {}),
    },
    family,
  );
}

/**
 * セグメントから表示名を組み立てる（Phase 3.2: 分数コードの層表示）。
 *
 * 層の考え方（PHASE3_PLAN.md §3.2）: 響きは「上層の和声」と「ベース音」
 * の2層であり、ベース補正が強いベース証拠でルートを潰したセグメント
 * では、潰れる前の和声（upperChord）が上層として別フィールドに残る。
 * 表示はその2層をそのまま X/Y の形で出す。
 *
 * ルール:
 * - upperChord があり bassPc もある場合、上層を土台にする:
 *   upperChord＋upperExtension で完全名を作り、addTones があれば
 *   "(add9)" を付け、ベースが上層ルートと異なれば（補正の定義上
 *   常に異なる） "/ベース" を付ける。ベースが三和音の構成音か
 *   どうかは問わない — ベースの証拠は補正級（強い）であることが
 *   upperChord の存在自体で担保されている。
 * - upperChord が無い場合は従来規則（Phase 1 Step 2）: 土台は chord
 *   ＋extension、分数表示はベースが三和音コアの構成音（3rd / 5th）
 *   の場合のみ。addTones があれば土台に "(add9)" を付ける。
 * - ベース音が無い／土台のルートと同じ場合は通常表示。
 * - 層フィールドを持たないセグメントでは従来表示と完全に一致する。
 *
 * family はベース音名のスペル系（移調表示用、lib/transpose.ts）。
 * 既定の "sharps" では従来表示と完全に一致する。土台のコード名
 * 自体のスペルは seg 側の文字列がそのまま使われる（移調時は
 * transpose 側がスペル済みの文字列を渡す）。
 */
export function displaySegmentChord(
  seg: ChordSegment,
  family: SpellingFamily = "sharps",
): string {
  const useUpper = seg.upperChord !== undefined && seg.bassPc !== undefined;
  const base = useUpper ? seg.upperChord! : seg.chord;
  const baseExt = useUpper ? seg.upperExtension : seg.extension;
  let full = fullChordName(base, baseExt);
  if (seg.addTones?.includes("add9")) {
    // add9 の表記は慣行に従う: メジャーは "Cadd9"、マイナーは "Am(add9)"
    full =
      parseChord(base)?.mode === "minor" ? `${full}(add9)` : `${full}add9`;
  }
  if (seg.bassPc === undefined) return full;
  const parsed = parseChord(base);
  if (!parsed) return full;
  const bass = ((seg.bassPc % 12) + 12) % 12;
  if (bass === parsed.root) return full;
  if (useUpper) return `${full}/${noteNameSpelled(bass, family)}`;
  if (!isChordToneBass(parsed.root, parsed.mode, bass)) return full;
  return `${full}/${noteNameSpelled(bass, family)}`;
}

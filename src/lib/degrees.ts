import { NO_CHORD } from "./notes";
import { isChordToneBass, parseChord } from "./chordDisplay";
import type {
  AddTone,
  AnalysisResult,
  ChordExtension,
  ChordSegment,
} from "../types";

/**
 * 機能和声の度数表示（ローマ数字）の純関数モジュール。
 *
 * コード名を「キーから見た度数表記」（例: A minor における Am → i、
 * B7 → II7）に変換する表示専用の層であり、解析パイプラインには
 * 一切接続しない（キートランスポーズ lib/transpose.ts と同じ
 * 「表示・書き出し用に導出するだけ」の位置づけ）。度数をいくら
 * 計算しても解析結果オブジェクトは変更されない。
 *
 * ## 文脈（キーの決め方）
 * セグメントの度数は、そのセグメントの局所キー（localKeys の窓、
 * セグメント中点を含む窓を優先）を基準にし、窓が無ければ曲全体の
 * キー（keyRoot / keyMode）で算出する（segmentDegreeInResult）。
 * 移調表示中は移調済みの結果（キー・局所キー・ラベルが全て移調済み）
 * に対して計算するため、度数は移調量によらず保存される。
 *
 * ## v1 の割り切り（表記の決め方）
 * - 度数は「ルートのキー内位置＋コードのクオリティ」だけで決める
 *   機械的な表記であり、機能解釈はしない。二次ドミナントを
 *   V7/V のように書くことはせず、例: C 長調の D7 は II7 と書く。
 *   借用和音も同様に、位置と質からの表記（♭VII 等）にとどめる。
 * - 大文字小文字はクオリティそのもので決める（キー側のダイアトニック
 *   な期待とは独立）: major → 大文字、minor → 小文字、dim → 小文字＋°、
 *   aug → 大文字＋+。拡張（maj7 / 7）はサフィックスとして付ける。
 * - 臨時記号は長調音階／自然短調音階を基準に決める。クロマチックな
 *   ルートは原則「次のダイアトニック度数の ♭」とし、例外は
 *   CHROMATIC_OVERRIDES の表に固定した（長調の ♯4、短調の
 *   ♯3 / ♯6 / ♯7）。和声短音階・旋律短音階などを基準にした
 *   表記（短調で導音を無印の vii とする等）は v1 では行わない。
 *   臨時記号はラベルのスペル（♯/♭）ではなくピッチクラスとキーから
 *   決めるため、異名同音のルート（例: C 長調における G# と Ab）は
 *   同じ度数（♭VI）になる。
 * - 分数コードは主コード（層表示の場合は上層）の度数を出し、
 *   表示側（displaySegmentChord）が分数として出す条件と同じ条件で
 *   ベース音の度数を "/" の後に続ける。ベース度数は単音の位置
 *   表示であり質を持たないため、大文字で統一する。
 * - N.C. のセグメントと、キー文脈が無い（key が null）場合は
 *   度数を出さない（null を返す）。
 */

/** 度数計算の基準となるキー文脈 */
export interface KeyContext {
  root: number; // 0=C .. 11=B
  mode: "major" | "minor";
}

/** 度数の大文字小文字と質記号を決めるクオリティ */
export type DegreeQuality = "major" | "minor" | "dim" | "aug";

const mod12 = (pc: number): number => ((pc % 12) + 12) % 12;

const ROMAN_NUMERALS = ["I", "II", "III", "IV", "V", "VI", "VII"] as const;

/** モードごとのダイアトニックなルート音程（半音）→ 度数（1..7） */
const DIATONIC_DEGREES: Record<KeyContext["mode"], ReadonlyMap<number, number>> = {
  major: new Map([
    [0, 1],
    [2, 2],
    [4, 3],
    [5, 4],
    [7, 5],
    [9, 6],
    [11, 7],
  ]),
  // 自然短調
  minor: new Map([
    [0, 1],
    [2, 2],
    [3, 3],
    [5, 4],
    [7, 5],
    [8, 6],
    [10, 7],
  ]),
};

/**
 * クロマチックなルート音程の割り当て例外（一般規則は「次の
 * ダイアトニック度数の ♭」）。
 * - 長調の音程 6: ♭V より ♯IV（#iv°、二次ドミナントのルート等）が
 *   通例のため ♯4 とする
 * - 短調の音程 4: ♭4 はまず使われないため ♯3 とする
 * - 短調の音程 9: ドリアの VI に当たる音で、♭7 とすると位置を
 *   誤らせるため ♯6 とする
 * - 短調の音程 11: 導音（和声短音階の第7音）に当たるため ♯7 とする
 */
const CHROMATIC_OVERRIDES: Record<
  KeyContext["mode"],
  ReadonlyMap<number, { degree: number; accidental: "♭" | "♯" }>
> = {
  major: new Map([[6, { degree: 4, accidental: "♯" }]]),
  minor: new Map([
    [4, { degree: 3, accidental: "♯" }],
    [9, { degree: 6, accidental: "♯" }],
    [11, { degree: 7, accidental: "♯" }],
  ]),
};

/** ルート音程（キー主音からの半音数）→ 度数と臨時記号 */
function degreeOfInterval(
  interval: number,
  mode: KeyContext["mode"],
): { degree: number; accidental: "" | "♭" | "♯" } {
  const direct = DIATONIC_DEGREES[mode].get(interval);
  if (direct !== undefined) return { degree: direct, accidental: "" };
  const override = CHROMATIC_OVERRIDES[mode].get(interval);
  if (override) return { ...override };
  // 一般規則: 半音上にある次のダイアトニック度数の ♭
  for (let step = 1; step < 12; step++) {
    const upper = DIATONIC_DEGREES[mode].get(mod12(interval + step));
    if (upper !== undefined) return { degree: upper, accidental: "♭" };
  }
  // ダイアトニック表はオクターブ内に必ず度数を含むため到達しない
  return { degree: 1, accidental: "" };
}

/**
 * ルート音（ピッチクラス）とクオリティから度数の核
 * （臨時記号＋ローマ数字＋質記号）を組み立てる。
 */
export function degreeCore(
  rootPc: number,
  quality: DegreeQuality,
  key: KeyContext,
): string {
  const { degree, accidental } = degreeOfInterval(
    mod12(rootPc - key.root),
    key.mode,
  );
  const numeral = ROMAN_NUMERALS[degree - 1];
  const lower = quality === "minor" || quality === "dim";
  const mark = quality === "dim" ? "°" : quality === "aug" ? "+" : "";
  return `${accidental}${lower ? numeral.toLowerCase() : numeral}${mark}`;
}

/**
 * 拡張音・付加音のサフィックス。有効な組み合わせはコード表示
 * （chordDisplay.fullChordName）の語彙と揃える:
 * major+maj7 → "maj7"、major+"7" → "7"、minor+m7 → "7"。
 * add9 はコード表示の慣行に倣い、メジャーは "add9" を直接、
 * マイナーは "(add9)" を付ける。
 */
function extensionSuffix(
  extension: ChordExtension | undefined,
  addTones: readonly AddTone[] | undefined,
  mode: "major" | "minor",
): string {
  let suffix = "";
  if (extension === "maj7" && mode === "major") suffix = "maj7";
  else if (extension === "7" && mode === "major") suffix = "7";
  else if (extension === "m7" && mode === "minor") suffix = "7";
  if (addTones?.includes("add9")) {
    suffix += suffix === "" && mode === "major" ? "add9" : "(add9)";
  }
  return suffix;
}

/**
 * コード名（"Am" 等の三和音コア）＋拡張から度数を組み立てる。
 * N.C. と解釈できないコード名、キー文脈が無い場合は null。
 */
export function chordLabelDegree(
  chord: string,
  extension: ChordExtension | undefined,
  addTones: readonly AddTone[] | undefined,
  key: KeyContext | null,
): string | null {
  if (key === null) return null;
  const parsed = parseChord(chord);
  if (!parsed) return null;
  return (
    degreeCore(parsed.root, parsed.mode, key) +
    extensionSuffix(extension, addTones, parsed.mode)
  );
}

/**
 * ベース音（ピッチクラス）の度数。単音の位置表示であり質を
 * 持たないため大文字で統一する（v1 の割り切り）。
 */
export function bassDegree(bassPc: number, key: KeyContext): string {
  return degreeCore(bassPc, "major", key);
}

/**
 * セグメントの度数。土台コードの選び方と分数表示の条件は
 * 表示側（chordDisplay.displaySegmentChord）と揃える:
 * - upperChord と bassPc が両方ある場合は上層が和声の土台で、
 *   ベースは常に分数として付ける
 * - 通常の場合は chord が土台で、ベースが三和音の構成音
 *   （3rd / 5th）の場合だけ分数として付ける
 * N.C. とキー文脈が無い場合は null。
 */
export function segmentDegree(
  seg: ChordSegment,
  key: KeyContext | null,
): string | null {
  if (key === null) return null;
  if (seg.chord === NO_CHORD) return null;
  const useUpper = seg.upperChord !== undefined && seg.bassPc !== undefined;
  const base = useUpper ? seg.upperChord! : seg.chord;
  const baseExt = useUpper ? seg.upperExtension : seg.extension;
  const main = chordLabelDegree(base, baseExt, seg.addTones, key);
  if (main === null) return null;
  if (seg.bassPc === undefined) return main;
  const parsed = parseChord(base);
  if (!parsed) return main;
  const bass = mod12(seg.bassPc);
  if (bass === parsed.root) return main;
  if (!useUpper && !isChordToneBass(parsed.root, parsed.mode, bass)) {
    return main;
  }
  return `${main}/${bassDegree(bass, key)}`;
}

/** キー文脈の解決に使う結果の部分型 */
export type ResultKeySource = Pick<
  AnalysisResult,
  "keyRoot" | "keyMode" | "localKeys"
>;

/**
 * セグメントのキー文脈を解決する。局所キー窓列がある場合は
 * セグメント中点を含む窓を優先し、中点を含む窓が無ければ
 * 重なりの最も大きい窓を使い、どちらも無ければ曲全体のキーに
 * 落ちる。
 */
export function keyContextForSegment(
  seg: ChordSegment,
  result: ResultKeySource,
): KeyContext {
  const windows = result.localKeys;
  if (windows && windows.length > 0) {
    const mid = (seg.start + seg.end) / 2;
    const containing = windows.find((w) => mid >= w.start && mid < w.end);
    if (containing) return { root: containing.root, mode: containing.mode };
    let best: { root: number; mode: "major" | "minor" } | null = null;
    let bestOverlap = 0;
    for (const w of windows) {
      const overlap =
        Math.min(seg.end, w.end) - Math.max(seg.start, w.start);
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        best = w;
      }
    }
    if (best) return { root: best.root, mode: best.mode };
  }
  return { root: result.keyRoot, mode: result.keyMode };
}

/** 解析結果の文脈（局所キー優先）でセグメントの度数を返す */
export function segmentDegreeInResult(
  seg: ChordSegment,
  result: ResultKeySource,
): string | null {
  return segmentDegree(seg, keyContextForSegment(seg, result));
}

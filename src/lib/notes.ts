/** 音名・コード名まわりのユーティリティ（ピッチクラス: 0=C, 1=C#, ..., 11=B） */

export const NOTE_NAMES = [
  "C",
  "C#",
  "D",
  "D#",
  "E",
  "F",
  "F#",
  "G",
  "G#",
  "A",
  "A#",
  "B",
] as const;

/** ♭ 系スペルの音名表（移調表示用。lib/transpose.ts のスペル規則参照） */
export const FLAT_NOTE_NAMES = [
  "C",
  "Db",
  "D",
  "Eb",
  "E",
  "F",
  "Gb",
  "G",
  "Ab",
  "A",
  "Bb",
  "B",
] as const;

/** 音名のスペル系。解析ラベルの既存慣習は "sharps"（NOTE_NAMES） */
export type SpellingFamily = "sharps" | "flats";

export const NO_CHORD = "N.C.";

export function noteName(pitchClass: number): string {
  const pc = ((pitchClass % 12) + 12) % 12;
  return NOTE_NAMES[pc];
}

/** スペル系を指定して音名を引く。"sharps" の結果は noteName と同一 */
export function noteNameSpelled(
  pitchClass: number,
  family: SpellingFamily,
): string {
  const pc = ((pitchClass % 12) + 12) % 12;
  return family === "flats" ? FLAT_NOTE_NAMES[pc] : NOTE_NAMES[pc];
}

const NOTE_NAME_TO_PC = new Map<string, number>();
NOTE_NAMES.forEach((n, i) => NOTE_NAME_TO_PC.set(n, i));
FLAT_NOTE_NAMES.forEach((n, i) => {
  if (!NOTE_NAME_TO_PC.has(n)) NOTE_NAME_TO_PC.set(n, i);
});

/**
 * 音名文字列（♯ 系・♭ 系のどちらでも）→ ピッチクラス。
 * 解釈できない文字列（"E#" 等の二重臨時記号を含む）は null。
 */
export function parseNoteName(name: string): number | null {
  return NOTE_NAME_TO_PC.get(name) ?? null;
}

/** ルート＋モードからコード名を作る（major: "C", minor: "Cm"） */
export function chordName(root: number, mode: "major" | "minor"): string {
  return mode === "major" ? noteName(root) : `${noteName(root)}m`;
}

/** セレクタ用: 全コード選択肢（12ルート × major/minor + N.C.） */
export function allChordOptions(): string[] {
  return allChordOptionsSpelled("sharps");
}

/** スペル系を指定した全コード選択肢。"sharps" の結果は allChordOptions と同一 */
export function allChordOptionsSpelled(family: SpellingFamily): string[] {
  const opts: string[] = [];
  for (let r = 0; r < 12; r++) {
    const root = noteNameSpelled(r, family);
    opts.push(root);
    opts.push(`${root}m`);
  }
  opts.push(NO_CHORD);
  return opts;
}

/** 秒 → "m:ss" 形式 */
export function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** 秒 → "m:ss.s" 形式（書き出し用） */
export function formatTimePrecise(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}

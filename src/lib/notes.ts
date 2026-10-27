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

export const NO_CHORD = "N.C.";

export function noteName(pitchClass: number): string {
  const pc = ((pitchClass % 12) + 12) % 12;
  return NOTE_NAMES[pc];
}

/** ルート＋モードからコード名を作る（major: "C", minor: "Cm"） */
export function chordName(root: number, mode: "major" | "minor"): string {
  return mode === "major" ? noteName(root) : `${noteName(root)}m`;
}

/** セレクタ用: 全コード選択肢（12ルート × major/minor + N.C.） */
export function allChordOptions(): string[] {
  const opts: string[] = [];
  for (let r = 0; r < 12; r++) {
    opts.push(chordName(r, "major"));
    opts.push(chordName(r, "minor"));
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

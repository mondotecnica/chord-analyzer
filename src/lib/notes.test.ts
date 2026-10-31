import { describe, expect, it } from "vitest";
import {
  allChordOptions,
  allChordOptionsSpelled,
  chordName,
  formatTime,
  noteName,
  noteNameSpelled,
  parseNoteName,
} from "./notes";

describe("notes ユーティリティ", () => {
  it("ピッチクラスから音名が得られる", () => {
    expect(noteName(0)).toBe("C");
    expect(noteName(1)).toBe("C#");
    expect(noteName(11)).toBe("B");
    expect(noteName(12)).toBe("C"); // ラップアラウンド
    expect(noteName(-1)).toBe("B");
  });

  it("コード名が組み立てられる", () => {
    expect(chordName(0, "major")).toBe("C");
    expect(chordName(9, "minor")).toBe("Am");
    expect(chordName(6, "major")).toBe("F#");
  });

  it("時刻フォーマット", () => {
    expect(formatTime(0)).toBe("0:00");
    expect(formatTime(65)).toBe("1:05");
    expect(formatTime(600)).toBe("10:00");
  });

  it("スペル系を指定した音名（flats は ♭ 表記、sharps は noteName と同一）", () => {
    expect(noteNameSpelled(1, "flats")).toBe("Db");
    expect(noteNameSpelled(3, "flats")).toBe("Eb");
    expect(noteNameSpelled(6, "flats")).toBe("Gb");
    expect(noteNameSpelled(10, "flats")).toBe("Bb");
    expect(noteNameSpelled(0, "flats")).toBe("C");
    for (let pc = 0; pc < 12; pc++) {
      expect(noteNameSpelled(pc, "sharps")).toBe(noteName(pc));
    }
  });

  it("音名文字列のパースは ♯ 系・♭ 系の両方を受け、解釈不能は null", () => {
    expect(parseNoteName("C")).toBe(0);
    expect(parseNoteName("C#")).toBe(1);
    expect(parseNoteName("Db")).toBe(1);
    expect(parseNoteName("Eb")).toBe(3);
    expect(parseNoteName("B")).toBe(11);
    expect(parseNoteName("E#")).toBeNull();
    expect(parseNoteName("H")).toBeNull();
    expect(parseNoteName("")).toBeNull();
  });

  it("スペル系つきコード選択肢（sharps は従来と同一）", () => {
    expect(allChordOptionsSpelled("sharps")).toEqual(allChordOptions());
    const flats = allChordOptionsSpelled("flats");
    expect(flats).toContain("Eb");
    expect(flats).toContain("Bbm");
    expect(flats).not.toContain("D#");
    expect(flats[flats.length - 1]).toBe("N.C.");
  });
});

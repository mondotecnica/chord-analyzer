import { describe, expect, it } from "vitest";
import { chordName, formatTime, noteName } from "./notes";

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
});

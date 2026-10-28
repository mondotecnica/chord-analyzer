import { describe, expect, it } from "vitest";
import { displayChordName, fullChordName, isChordToneBass } from "./chordDisplay";

describe("displayChordName（分数コード表示）", () => {
  it("ベース音が未指定なら通常表示", () => {
    expect(displayChordName("C")).toBe("C");
    expect(displayChordName("Am", undefined)).toBe("Am");
  });

  it("ベース音 = ルートなら通常表示", () => {
    expect(displayChordName("C", 0)).toBe("C");
    expect(displayChordName("Am", 9)).toBe("Am");
    expect(displayChordName("G", 7)).toBe("G");
  });

  it("ベース音が 3rd なら分数表示（major）", () => {
    expect(displayChordName("C", 4)).toBe("C/E");
    expect(displayChordName("F", 9)).toBe("F/A");
    expect(displayChordName("G", 11)).toBe("G/B");
  });

  it("ベース音が 5th なら分数表示（major）", () => {
    expect(displayChordName("C", 7)).toBe("C/G");
    expect(displayChordName("G", 2)).toBe("G/D");
  });

  it("minor コードでも 3rd / 5th で分数表示になる", () => {
    expect(displayChordName("Am", 4)).toBe("Am/E"); // 5th
    expect(displayChordName("Am", 0)).toBe("Am/C"); // minor 3rd
    expect(displayChordName("Dm", 9)).toBe("Dm/A"); // 5th
  });

  it("ベース音が構成音でなければ通常表示のまま", () => {
    expect(displayChordName("C", 9)).toBe("C"); // 6th
    expect(displayChordName("C", 2)).toBe("C"); // 9th(2nd)
    expect(displayChordName("Am", 7)).toBe("Am"); // 4th(11th)
  });

  it("N.C. はそのまま", () => {
    expect(displayChordName("N.C.", 4)).toBe("N.C.");
    expect(displayChordName("N.C.")).toBe("N.C.");
  });

  it("シャープを含むルートでも組み立てられる", () => {
    expect(displayChordName("F#", 10)).toBe("F#/A#"); // 3rd
  });
});

describe("fullChordName / displayChordName（Phase 3.1 拡張音）", () => {
  it("完全名を組み立てる: CM7 / C7 / Am7", () => {
    expect(fullChordName("C", "maj7")).toBe("CM7");
    expect(fullChordName("B", "7")).toBe("B7");
    expect(fullChordName("E", "7")).toBe("E7");
    expect(fullChordName("Am", "m7")).toBe("Am7");
    expect(fullChordName("F#", "maj7")).toBe("F#M7");
  });

  it("拡張なし・語彙外の組み合わせはコアのまま", () => {
    expect(fullChordName("C")).toBe("C");
    expect(fullChordName("C", "m7")).toBe("C"); // major + m7 は出さない
    expect(fullChordName("Am", "maj7")).toBe("Am"); // mMaj7 は初期語彙外
    expect(fullChordName("N.C.", "7")).toBe("N.C.");
  });

  it("表示名は完全名＋分数を組み立てる", () => {
    expect(displayChordName("B", 11, "7")).toBe("B7");
    expect(displayChordName("C", 4, "maj7")).toBe("CM7/E");
    expect(displayChordName("Am", 9, "m7")).toBe("Am7");
  });
});

describe("isChordToneBass", () => {
  it("major の 3rd / 5th を構成音と判定する", () => {
    expect(isChordToneBass(0, "major", 4)).toBe(true);
    expect(isChordToneBass(0, "major", 7)).toBe(true);
    expect(isChordToneBass(0, "major", 3)).toBe(false);
  });

  it("minor の 3rd は +3", () => {
    expect(isChordToneBass(9, "minor", 0)).toBe(true);
    expect(isChordToneBass(9, "minor", 4)).toBe(true); // 5th
    expect(isChordToneBass(9, "minor", 1)).toBe(false);
  });
});

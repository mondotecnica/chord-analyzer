import { describe, expect, it } from "vitest";
import {
  displayChordName,
  displaySegmentChord,
  fullChordName,
  isChordToneBass,
} from "./chordDisplay";
import type { ChordSegment } from "../types";

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

describe("displaySegmentChord（Phase 3.2: 層表示）", () => {
  const seg = (extra: Partial<ChordSegment>): ChordSegment => ({
    id: 0,
    start: 0,
    end: 1,
    chord: "C",
    confidence: 0.7,
    ...extra,
  });

  it("層フィールドが無ければ従来表示と一致する", () => {
    expect(displaySegmentChord(seg({ chord: "C", bassPc: 4 }))).toBe("C/E");
    expect(displaySegmentChord(seg({ chord: "C", bassPc: 9 }))).toBe("C");
    expect(displaySegmentChord(seg({ chord: "Am", bassPc: 9 }))).toBe("Am");
  });

  it("上層＋ベースで分数表示になる（ベースが構成音でなくても）", () => {
    // Suno Q1 型: 上層 C、ベース D（C の構成音ではない）
    expect(
      displaySegmentChord(seg({ chord: "Dm", upperChord: "C", bassPc: 2 })),
    ).toBe("C/D");
  });

  it("上層の 7th 拡張が表示に乗る", () => {
    expect(
      displaySegmentChord(
        seg({ chord: "Dm", upperChord: "Am", upperExtension: "m7", bassPc: 2 }),
      ),
    ).toBe("Am7/D");
    // Suno Q4 型: 上層 CM7、ベース C#
    expect(
      displaySegmentChord(
        seg({ chord: "C#m", upperChord: "C", upperExtension: "maj7", bassPc: 1 }),
      ),
    ).toBe("CM7/C#");
  });

  it("add9 の表記はメジャー Cadd9 / マイナー Am(add9)", () => {
    expect(displaySegmentChord(seg({ chord: "C", addTones: ["add9"] }))).toBe("Cadd9");
    expect(displaySegmentChord(seg({ chord: "Am", addTones: ["add9"] }))).toBe("Am(add9)");
    expect(
      displaySegmentChord(
        seg({ chord: "C#m", upperChord: "Am", addTones: ["add9"], bassPc: 1 }),
      ),
    ).toBe("Am(add9)/C#");
  });

  it("ベースが上層ルートと同じなら分数表示にしない", () => {
    expect(
      displaySegmentChord(seg({ chord: "Dm", upperChord: "D", bassPc: 2 })),
    ).toBe("D");
  });

  it("bassPc が無ければ層は表示されず chord 側の表示になる", () => {
    expect(
      displaySegmentChord(seg({ chord: "Dm", upperChord: "Am", upperExtension: "7" })),
    ).toBe("Dm");
  });
});

describe("♭ 系スペルのラベルとスペル系つき表示（移調表示用）", () => {
  const seg = (extra: Partial<ChordSegment>): ChordSegment => ({
    id: 0,
    start: 0,
    end: 1,
    chord: "C",
    confidence: 0.7,
    ...extra,
  });

  it("♭ 系スペルのコード名も解釈できる", () => {
    expect(displayChordName("Eb", 7)).toBe("Eb/G"); // 3rd
    expect(displayChordName("Bbm", 10)).toBe("Bbm"); // ベース = ルート
    expect(displayChordName("Bbm", 5)).toBe("Bbm/F"); // 5th
    expect(fullChordName("Eb", "maj7")).toBe("EbM7");
    expect(fullChordName("Bbm", "m7")).toBe("Bbm7");
  });

  it("ベース音名は既定で ♯ 系、family 指定で ♭ 系になる", () => {
    const s = seg({ chord: "Db", bassPc: 8 }); // 5th ベース
    expect(displaySegmentChord(s)).toBe("Db/G#");
    expect(displaySegmentChord(s, "flats")).toBe("Db/Ab");
  });

  it("層表示のベース音名もスペル系に従う", () => {
    const s = seg({
      chord: "Ebm",
      upperChord: "Db",
      upperExtension: "maj7",
      bassPc: 8,
    });
    expect(displaySegmentChord(s, "flats")).toBe("DbM7/Ab");
    expect(displaySegmentChord(s)).toBe("DbM7/G#");
  });
});

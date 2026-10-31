import { describe, expect, it } from "vitest";
import {
  capoFretForShift,
  keySpelling,
  spellingForShift,
  transposeAnalysisResult,
  transposeChordLabel,
  transposeLocalKeyWindows,
  transposeSegment,
  transposeSegments,
  transposedKey,
} from "./transpose";
import { displaySegmentChord } from "./chordDisplay";
import { allChordOptions } from "./notes";
import type { AnalysisResult, ChordSegment } from "../types";

const seg = (extra: Partial<ChordSegment>): ChordSegment => ({
  id: 0,
  start: 0,
  end: 1,
  chord: "C",
  confidence: 0.7,
  ...extra,
});

describe("keySpelling（調号ベースのスペル規則）", () => {
  it("メジャー: 臨時記号が少ない表記を採用する", () => {
    expect(keySpelling(0, "major")).toEqual({ name: "C", family: "sharps" });
    expect(keySpelling(1, "major")).toEqual({ name: "Db", family: "flats" });
    expect(keySpelling(3, "major")).toEqual({ name: "Eb", family: "flats" });
    expect(keySpelling(5, "major")).toEqual({ name: "F", family: "flats" });
    expect(keySpelling(8, "major")).toEqual({ name: "Ab", family: "flats" });
    expect(keySpelling(10, "major")).toEqual({ name: "Bb", family: "flats" });
    expect(keySpelling(11, "major")).toEqual({ name: "B", family: "sharps" });
  });

  it("メジャー: F#/Gb は同数（6つ同士）のため ♯ 優先で F#", () => {
    expect(keySpelling(6, "major")).toEqual({ name: "F#", family: "sharps" });
  });

  it("マイナー: 関係調の調号で判定する", () => {
    expect(keySpelling(9, "minor")).toEqual({ name: "A", family: "sharps" });
    expect(keySpelling(0, "minor")).toEqual({ name: "C", family: "flats" }); // Cm = 関係調 Eb の 3♭
    expect(keySpelling(2, "minor")).toEqual({ name: "D", family: "flats" }); // Dm = 1♭
    expect(keySpelling(5, "minor")).toEqual({ name: "F", family: "flats" }); // Fm = 4♭
    expect(keySpelling(7, "minor")).toEqual({ name: "G", family: "flats" }); // Gm = 2♭
    expect(keySpelling(10, "minor")).toEqual({ name: "Bb", family: "flats" }); // Bbm = 関係調 Db の 5♭
    expect(keySpelling(8, "minor")).toEqual({ name: "G#", family: "sharps" }); // G#m(5♯) < Abm(7♭)
    expect(keySpelling(1, "minor")).toEqual({ name: "C#", family: "sharps" }); // C#m(4♯) < Dbm(8♭)
  });

  it("マイナー: D#m/Ebm は同数（6つ同士）のため ♯ 優先で D#", () => {
    expect(keySpelling(3, "minor")).toEqual({ name: "D#", family: "sharps" });
  });
});

describe("spellingForShift / transposedKey", () => {
  it("移調先キーの調号でスペル系が決まる", () => {
    expect(spellingForShift(0, "major", 3)).toBe("flats"); // C → Eb major
    expect(spellingForShift(0, "major", 2)).toBe("sharps"); // C → D major
    expect(spellingForShift(0, "major", -2)).toBe("flats"); // C → Bb major
    expect(spellingForShift(9, "minor", 3)).toBe("flats"); // Am → C minor
    expect(spellingForShift(9, "minor", 2)).toBe("sharps"); // Am → B minor
    expect(spellingForShift(0, "major", 6)).toBe("sharps"); // C → F# major
  });

  it("キーの移調はモードを変えず、ピッチクラスをラップする", () => {
    expect(transposedKey(11, "major", 2)).toEqual({ root: 1, mode: "major" });
    expect(transposedKey(0, "minor", -1)).toEqual({ root: 11, mode: "minor" });
  });
});

describe("transposeChordLabel", () => {
  it("♯ 系キーへの移調は ♯ スペルで返す", () => {
    expect(transposeChordLabel("C", 2, "sharps")).toBe("D");
    expect(transposeChordLabel("Am", 2, "sharps")).toBe("Bm");
    expect(transposeChordLabel("F#", 2, "sharps")).toBe("G#");
    expect(transposeChordLabel("C", -1, "sharps")).toBe("B");
  });

  it("♭ 系キーへの移調は ♭ スペルで返す", () => {
    expect(transposeChordLabel("C", 3, "flats")).toBe("Eb");
    expect(transposeChordLabel("Am", 3, "flats")).toBe("Cm");
    expect(transposeChordLabel("G", -2, "flats")).toBe("F");
    expect(transposeChordLabel("D", -2, "flats")).toBe("C");
    expect(transposeChordLabel("E", -2, "flats")).toBe("D");
    expect(transposeChordLabel("A", -2, "flats")).toBe("G");
    // Bb major 文脈の V は F、ii は Cm、vi は Gm
    expect(transposeChordLabel("C", -2, "flats")).toBe("Bb");
    expect(transposeChordLabel("Dm", -2, "flats")).toBe("Cm");
    expect(transposeChordLabel("Am", -2, "flats")).toBe("Gm");
  });

  it("N.C. と解釈できないラベルは無変換", () => {
    expect(transposeChordLabel("N.C.", 5, "flats")).toBe("N.C.");
    expect(transposeChordLabel("N.C.", -3, "sharps")).toBe("N.C.");
  });

  it("全ラベル × 全移調量で、逆移調すると元の ♯ 系表記に戻る", () => {
    const labels = allChordOptions();
    const contexts = [
      { root: 0, mode: "major" as const },
      { root: 9, mode: "minor" as const },
      { root: 5, mode: "major" as const },
    ];
    for (const ctx of contexts) {
      for (let shift = -11; shift <= 11; shift++) {
        if (shift === 0) continue;
        const family = spellingForShift(ctx.root, ctx.mode, shift);
        for (const label of labels) {
          const moved = transposeChordLabel(label, shift, family);
          const back = transposeChordLabel(moved, -shift, "sharps");
          expect(back).toBe(label);
        }
      }
    }
  });
});

describe("transposeSegment", () => {
  it("移調量 0 / ±12 は同じオブジェクトを返す（恒等性）", () => {
    const s = seg({ chord: "Am", bassPc: 4 });
    expect(transposeSegment(s, 0, "sharps")).toBe(s);
    expect(transposeSegment(s, 12, "flats")).toBe(s);
    expect(transposeSegment(s, -12, "flats")).toBe(s);
  });

  it("ルートとベース音が移調され、元のセグメントは変更されない", () => {
    const s = seg({ chord: "C", bassPc: 4 });
    const t = transposeSegment(s, 3, "flats");
    expect(t.chord).toBe("Eb");
    expect(t.bassPc).toBe(7);
    expect(s.chord).toBe("C");
    expect(s.bassPc).toBe(4);
    // 分数表示まで通すと Eb/G（3rd ベース）
    expect(displaySegmentChord(t, "flats")).toBe("Eb/G");
  });

  it("拡張音・付加音は音程語彙なので無変換で保持される", () => {
    const t = transposeSegment(seg({ chord: "B", extension: "7" }), 2, "sharps");
    expect(t.chord).toBe("C#");
    expect(t.extension).toBe("7");
    expect(displaySegmentChord(t)).toBe("C#7");

    const u = transposeSegment(seg({ chord: "C", addTones: ["add9"] }), 2, "sharps");
    expect(u.addTones).toEqual(["add9"]);
    expect(displaySegmentChord(u)).toBe("Dadd9");
  });

  it("層表示（upperChord / upperExtension / bassPc）が一括で移調される", () => {
    // Suno Q1 型: 上層 C、ベース D
    const t = transposeSegment(
      seg({ chord: "Dm", upperChord: "C", bassPc: 2 }),
      3,
      "flats",
    );
    expect(t.chord).toBe("Fm");
    expect(t.upperChord).toBe("Eb");
    expect(t.bassPc).toBe(5);
    expect(displaySegmentChord(t, "flats")).toBe("Eb/F");
  });

  it("層表示 + 7th 拡張（Suno Q4 型: CM7/C#）も移調される", () => {
    const s = seg({
      chord: "C#m",
      upperChord: "C",
      upperExtension: "maj7",
      bassPc: 1,
    });
    const t = transposeSegment(s, -1, "sharps"); // B major 文脈
    expect(t.upperChord).toBe("B");
    expect(t.upperExtension).toBe("maj7");
    expect(t.bassPc).toBe(0);
    expect(displaySegmentChord(t, "sharps")).toBe("BM7/C");
  });

  it("N.C. セグメントは無変換（ベース証拠も付いていない前提）", () => {
    const t = transposeSegment(seg({ chord: "N.C.", bassPc: undefined }), 5, "flats");
    expect(t.chord).toBe("N.C.");
  });

  it("候補リストの root / bassPc も移調される", () => {
    const s = seg({
      chord: "C",
      candidates: [
        { root: 0, mode: "major", bassPc: 2, score: 0.9, margin: 0 },
        { root: 9, mode: "minor", score: 0.8, margin: 0.1 },
      ],
    });
    const t = transposeSegment(s, 3, "flats");
    expect(t.candidates?.[0]).toMatchObject({ root: 3, bassPc: 5 });
    expect(t.candidates?.[1]).toMatchObject({ root: 0 });
    expect(t.candidates?.[1]).not.toHaveProperty("bassPc");
  });

  it("往復移調で元のセグメント表示に戻る", () => {
    const s = seg({ chord: "Dm", upperChord: "C", bassPc: 2 });
    const moved = transposeSegment(s, 5, "flats"); // C major → F major 文脈
    const back = transposeSegment(moved, -5, "sharps");
    expect(back.chord).toBe("Dm");
    expect(back.upperChord).toBe("C");
    expect(back.bassPc).toBe(2);
  });
});

describe("transposeSegments / transposeLocalKeyWindows", () => {
  it("移調量 0 では入力配列をそのまま返す", () => {
    const list = [seg({})];
    expect(transposeSegments(list, 0, "sharps")).toBe(list);
    const windows = [
      {
        start: 0,
        end: 10,
        root: 0,
        mode: "major" as const,
        correlation: 0.9,
        margin: 0.1,
        runnerUpRoot: 9,
        runnerUpMode: "minor" as const,
      },
    ];
    expect(transposeLocalKeyWindows(windows, 0)).toBe(windows);
    const moved = transposeLocalKeyWindows(windows, 3);
    expect(moved[0]).toMatchObject({ root: 3, runnerUpRoot: 0 });
    expect(moved[0].correlation).toBe(0.9);
  });
});

describe("transposeAnalysisResult", () => {
  const baseResult = (): AnalysisResult => ({
    fileName: "song.mp3",
    duration: 100,
    sampleRate: 44100,
    keyName: "C major",
    keyRoot: 0,
    keyMode: "major",
    bpm: 120,
    segments: [seg({ chord: "C", bassPc: 4 }), seg({ id: 1, chord: "Am" })],
    analyzedInMs: 10,
    localKeys: [
      {
        start: 0,
        end: 10,
        root: 0,
        mode: "major",
        correlation: 0.9,
        margin: 0.1,
        runnerUpRoot: 9,
        runnerUpMode: "minor",
      },
    ],
  });

  it("移調量 0 / ±12 では入力と同一オブジェクトを返す", () => {
    const r = baseResult();
    expect(transposeAnalysisResult(r, 0).result).toBe(r);
    expect(transposeAnalysisResult(r, 12).result).toBe(r);
    expect(transposeAnalysisResult(r, -12).result).toBe(r);
    expect(transposeAnalysisResult(r, 0).family).toBe("sharps");
  });

  it("全体キー・keyName・局所キー・セグメントが移調される", () => {
    const { result, family } = transposeAnalysisResult(baseResult(), 3);
    expect(family).toBe("flats");
    expect(result.keyRoot).toBe(3);
    expect(result.keyMode).toBe("major");
    expect(result.keyName).toBe("Eb major");
    expect(result.segments[0].chord).toBe("Eb");
    expect(result.segments[0].bassPc).toBe(7);
    expect(result.segments[1].chord).toBe("Cm");
    expect(result.localKeys?.[0]).toMatchObject({ root: 3, runnerUpRoot: 0 });
    // BPM やファイル名など、キーと無関係な記録は移調しない
    expect(result.bpm).toBe(120);
    expect(result.fileName).toBe("song.mp3");
  });
});

describe("capoFretForShift", () => {
  it("下げ移調では Capo (−移調量) が返る", () => {
    expect(capoFretForShift(-1)).toBe(1);
    expect(capoFretForShift(-2)).toBe(2);
    expect(capoFretForShift(-6)).toBe(6);
  });

  it("移調なし・実用範囲外では null（提示しない）", () => {
    expect(capoFretForShift(0)).toBeNull();
    expect(capoFretForShift(-7)).toBeNull(); // Capo 7 は実用範囲外
    expect(capoFretForShift(1)).toBeNull(); // Capo 11 は提示しない
    expect(capoFretForShift(5)).toBeNull(); // Capo 7 は提示しない
  });

  it("+6（トリトーン上）は Capo 6 が数学的に成立するため返す", () => {
    expect(capoFretForShift(6)).toBe(6);
  });
});

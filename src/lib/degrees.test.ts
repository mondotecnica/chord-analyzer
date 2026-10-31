import { describe, expect, it } from "vitest";
import {
  chordLabelDegree,
  degreeCore,
  keyContextForSegment,
  segmentDegree,
  segmentDegreeInResult,
  type KeyContext,
} from "./degrees";
import type {
  AnalysisResult,
  ChordSegment,
  LocalKeyWindow,
} from "../types";

const C_MAJOR: KeyContext = { root: 0, mode: "major" };
const A_MINOR: KeyContext = { root: 9, mode: "minor" };

const seg = (extra: Partial<ChordSegment>): ChordSegment => ({
  id: 0,
  start: 0,
  end: 1,
  chord: "C",
  confidence: 0.7,
  ...extra,
});

const result = (over: Partial<AnalysisResult> = {}): AnalysisResult => ({
  fileName: "song.mp3",
  duration: 100,
  sampleRate: 44100,
  keyName: "C major",
  keyRoot: 0,
  keyMode: "major",
  bpm: 120,
  segments: [],
  analyzedInMs: 1,
  ...over,
});

const window_ = (over: Partial<LocalKeyWindow> = {}): LocalKeyWindow => ({
  start: 0,
  end: 10,
  root: 9,
  mode: "minor",
  correlation: 0.9,
  margin: 0.1,
  runnerUpRoot: 0,
  runnerUpMode: "major",
  ...over,
});

describe("長調キーでの度数（C major）", () => {
  it("ダイアトニックな三和音: 大文字小文字はクオリティで決まる", () => {
    expect(chordLabelDegree("C", undefined, undefined, C_MAJOR)).toBe("I");
    expect(chordLabelDegree("D", undefined, undefined, C_MAJOR)).toBe("II");
    expect(chordLabelDegree("Dm", undefined, undefined, C_MAJOR)).toBe("ii");
    expect(chordLabelDegree("Em", undefined, undefined, C_MAJOR)).toBe("iii");
    expect(chordLabelDegree("F", undefined, undefined, C_MAJOR)).toBe("IV");
    expect(chordLabelDegree("G", undefined, undefined, C_MAJOR)).toBe("V");
    expect(chordLabelDegree("Am", undefined, undefined, C_MAJOR)).toBe("vi");
  });

  it("dim は小文字＋°、aug は大文字＋+", () => {
    expect(degreeCore(11, "dim", C_MAJOR)).toBe("vii°"); // Bdim
    expect(degreeCore(5, "aug", C_MAJOR)).toBe("IV+"); // Faug
  });

  it("借用和音は ♭ 前置（♭II / ♭III / ♭VI / ♭VII）", () => {
    expect(chordLabelDegree("Db", undefined, undefined, C_MAJOR)).toBe("♭II");
    expect(chordLabelDegree("Eb", undefined, undefined, C_MAJOR)).toBe("♭III");
    expect(chordLabelDegree("Ab", undefined, undefined, C_MAJOR)).toBe("♭VI");
    expect(chordLabelDegree("Bb", undefined, undefined, C_MAJOR)).toBe("♭VII");
  });

  it("長調の音程6は例外として ♯IV", () => {
    expect(chordLabelDegree("F#", undefined, undefined, C_MAJOR)).toBe("♯IV");
  });

  it("二次ドミナントの機能解釈はしない（D7 は V7/V でなく II7）", () => {
    expect(chordLabelDegree("D", "7", undefined, C_MAJOR)).toBe("II7");
  });
});

describe("短調キーでの度数（A minor）", () => {
  it("自然短調のダイアトニックな三和音", () => {
    expect(chordLabelDegree("Am", undefined, undefined, A_MINOR)).toBe("i");
    expect(chordLabelDegree("C", undefined, undefined, A_MINOR)).toBe("III");
    expect(chordLabelDegree("Dm", undefined, undefined, A_MINOR)).toBe("iv");
    expect(chordLabelDegree("Em", undefined, undefined, A_MINOR)).toBe("v");
    expect(chordLabelDegree("F", undefined, undefined, A_MINOR)).toBe("VI");
    expect(chordLabelDegree("G", undefined, undefined, A_MINOR)).toBe("VII");
  });

  it("B7 → II7（仕様の代表例）", () => {
    expect(chordLabelDegree("B", "7", undefined, A_MINOR)).toBe("II7");
  });

  it("和声短音階側の V は大文字（クオリティ準拠）", () => {
    expect(chordLabelDegree("E", undefined, undefined, A_MINOR)).toBe("V");
    expect(chordLabelDegree("E", "7", undefined, A_MINOR)).toBe("V7");
  });

  it("導音ルートは ♯7、ドリアの VI ルートは ♯6", () => {
    expect(degreeCore(8, "dim", A_MINOR)).toBe("♯vii°"); // G#dim
    expect(chordLabelDegree("F#", undefined, undefined, A_MINOR)).toBe("♯VI");
  });
});

describe("拡張・付加音のサフィックス", () => {
  it("maj7 / 7 / m7 が付く", () => {
    expect(chordLabelDegree("C", "maj7", undefined, C_MAJOR)).toBe("Imaj7");
    expect(chordLabelDegree("G", "7", undefined, C_MAJOR)).toBe("V7");
    expect(chordLabelDegree("Am", "m7", undefined, C_MAJOR)).toBe("vi7");
    expect(chordLabelDegree("Dm", "m7", undefined, C_MAJOR)).toBe("ii7");
    expect(chordLabelDegree("Am", "m7", undefined, A_MINOR)).toBe("i7");
  });

  it("add9 はメジャーで直接、マイナーで括弧つき（コード表示の慣行）", () => {
    expect(chordLabelDegree("C", undefined, ["add9"], C_MAJOR)).toBe("Iadd9");
    expect(chordLabelDegree("Am", undefined, ["add9"], C_MAJOR)).toBe(
      "vi(add9)",
    );
  });

  it("語彙外の組み合わせ（minor + maj7）は拡張を付けない", () => {
    expect(chordLabelDegree("Am", "maj7", undefined, C_MAJOR)).toBe("vi");
  });
});

describe("segmentDegree（分数コードと層表示）", () => {
  it("通常の分数: ベースが構成音（3rd）の場合だけ付ける", () => {
    expect(segmentDegree(seg({ chord: "C", bassPc: 4 }), C_MAJOR)).toBe(
      "I/III",
    );
    expect(segmentDegree(seg({ chord: "C", bassPc: 7 }), C_MAJOR)).toBe(
      "I/V",
    );
  });

  it("ベースが非構成音の場合は主度数のみ（表示側の条件と一致）", () => {
    expect(segmentDegree(seg({ chord: "C", bassPc: 2 }), C_MAJOR)).toBe("I");
  });

  it("ベースがルートと同じ場合は主度数のみ", () => {
    expect(
      segmentDegree(seg({ chord: "Am", extension: "m7", bassPc: 9 }), A_MINOR),
    ).toBe("i7");
  });

  it("層表示: 上層の度数＋ベース度数（Am7/D の層）", () => {
    const layered = seg({
      chord: "D",
      upperChord: "Am",
      upperExtension: "m7",
      bassPc: 2,
    });
    expect(segmentDegree(layered, A_MINOR)).toBe("i7/IV");
    expect(segmentDegree(layered, C_MAJOR)).toBe("vi7/II");
  });

  it("層表示でもベースが上層ルートと同じなら主度数のみ", () => {
    const layered = seg({
      chord: "A",
      upperChord: "Am",
      upperExtension: "m7",
      bassPc: 9,
    });
    expect(segmentDegree(layered, A_MINOR)).toBe("i7");
  });

  it("upperChord があっても bassPc が無ければ通常コードとして扱う", () => {
    expect(
      segmentDegree(seg({ chord: "D", upperChord: "Am" }), C_MAJOR),
    ).toBe("II");
  });

  it("N.C. は null、キー文脈が無い場合も null", () => {
    expect(segmentDegree(seg({ chord: "N.C." }), C_MAJOR)).toBeNull();
    expect(segmentDegree(seg({ chord: "C" }), null)).toBeNull();
    expect(chordLabelDegree("C", undefined, undefined, null)).toBeNull();
    expect(chordLabelDegree("N.C.", undefined, undefined, C_MAJOR)).toBeNull();
  });
});

describe("keyContextForSegment（局所キー優先）", () => {
  it("局所キーが無ければ全体キー", () => {
    const r = result();
    expect(keyContextForSegment(seg({ start: 0, end: 2 }), r)).toEqual({
      root: 0,
      mode: "major",
    });
    expect(
      segmentDegreeInResult(seg({ chord: "Am", start: 0, end: 2 }), r),
    ).toBe("vi");
  });

  it("中点を含む窓の局所キーを優先する", () => {
    const r = result({ localKeys: [window_()] }); // 0-10s: A minor
    expect(
      segmentDegreeInResult(seg({ chord: "Am", start: 2, end: 4 }), r),
    ).toBe("i");
    // 窓の外は全体キー（C major）に落ちる
    expect(
      segmentDegreeInResult(seg({ chord: "Am", start: 20, end: 24 }), r),
    ).toBe("vi");
  });

  it("複数窓では中点の属する窓が選ばれる", () => {
    const r = result({
      localKeys: [
        window_(), // 0-10s: A minor
        window_({ start: 10, end: 20, root: 7, mode: "major" }), // G major
      ],
    });
    // 中点 11s は G major の窓: Am は ii
    expect(
      segmentDegreeInResult(seg({ chord: "Am", start: 8, end: 14 }), r),
    ).toBe("ii");
  });

  it("中点を含む窓が無ければ重なりの最大の窓を使う", () => {
    const r = result({ localKeys: [window_()] }); // 0-10s: A minor
    // 中点 10s は窓の外（end は排他）だが重なりは 1s ある
    expect(
      segmentDegreeInResult(seg({ chord: "Am", start: 9, end: 11 }), r),
    ).toBe("i");
  });
});

describe("解析不変性（度数計算は結果を変更しない）", () => {
  it("結果オブジェクトとセグメントが一切変わらない", () => {
    const segments: ChordSegment[] = [
      seg({ id: 0, chord: "Am", extension: "m7", bassPc: 2, start: 0, end: 2 }),
      seg({
        id: 1,
        chord: "D",
        upperChord: "Am",
        upperExtension: "m7",
        bassPc: 2,
        start: 2,
        end: 4,
      }),
      seg({ id: 2, chord: "N.C.", start: 4, end: 6 }),
    ];
    const r = result({ segments, localKeys: [window_()] });
    const before = JSON.stringify(r);
    const refs = [...r.segments];
    const first = r.segments.map((s) => segmentDegreeInResult(s, r));
    const second = r.segments.map((s) => segmentDegreeInResult(s, r));
    // 1件目: ベース D は Am の非構成音のため分数にならない（表示側と同条件）
    expect(first).toEqual(["i7", "i7/IV", null]);
    expect(second).toEqual(first); // 決定的（同じ入力→同じ出力）
    expect(JSON.stringify(r)).toBe(before);
    r.segments.forEach((s, i) => expect(s).toBe(refs[i]));
  });
});

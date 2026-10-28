import { describe, expect, it } from "vitest";
import { estimateChordFrames, matchChord } from "./chordEstimation";

/** 指定ピッチクラスだけが立つ合成クロマを作る */
function syntheticChroma(pitchClasses: number[], value = 1): Float32Array {
  const v = new Float32Array(12);
  for (const pc of pitchClasses) v[pc] = value;
  // L1 正規化（実データのクロマと同じ形式）
  const sum = v.reduce((s, x) => s + x, 0);
  for (let i = 0; i < 12; i++) v[i] /= sum;
  return v;
}

describe("matchChord（テンプレートマッチング）", () => {
  it("C メジャーのクロマ（C, E, G）からは C が得られる", () => {
    const m = matchChord(syntheticChroma([0, 4, 7]));
    expect(m.chord).toBe("C");
    expect(m.score).toBeGreaterThan(0.9);
  });

  it("A マイナーのクロマ（A, C, E）からは Am が得られる", () => {
    const m = matchChord(syntheticChroma([9, 0, 4]));
    expect(m.chord).toBe("Am");
  });

  it("G メジャーのクロマ（G, B, D）からは G が得られる", () => {
    const m = matchChord(syntheticChroma([7, 11, 2]));
    expect(m.chord).toBe("G");
  });

  it("全ゼロのクロマは N.C. になる", () => {
    const m = matchChord(new Float32Array(12));
    expect(m.chord).toBe("N.C.");
    expect(m.score).toBe(0);
  });

  it("ノイズが多少混ざっても正しいコードが勝つ", () => {
    const chroma = syntheticChroma([5, 9, 0]); // F メジャー (F, A, C)
    for (let i = 0; i < 12; i++) chroma[i] += 0.05;
    const m = matchChord(chroma);
    expect(m.chord).toBe("F");
  });
});

describe("estimateChordFrames の無音ゲート（曲参照ゲートの再設計）", () => {
  // 前半 5 フレームが大きく（エネルギー 1.0）、後半 5 フレームが
  // 相対的に静か（0.05）な列。判定経路の中央値は 1.0 なので、
  // 現行ゲートのしきい値は 0.15 で後半は全て落ちる。
  const FD = 0.05;
  const judgeEnergies = new Float32Array([
    1, 1, 1, 1, 1, 0.05, 0.05, 0.05, 0.05, 0.05,
  ]);
  const chromas = Array.from({ length: 10 }, () =>
    syntheticChroma([0, 4, 7]),
  );
  const chordsOf = (
    frames: ReturnType<typeof estimateChordFrames>,
  ): string[] => frames.map((f) => f.chord);

  it("legacy（既定）: 相対的に静かなフレームは N.C. になる", () => {
    const frames = estimateChordFrames(chromas, judgeEnergies, FD);
    expect(chordsOf(frames)).toEqual([
      "C", "C", "C", "C", "C",
      "N.C.", "N.C.", "N.C.", "N.C.", "N.C.",
    ]);
  });

  it("song-referenced: 曲全体が鳴っている瞬間は静かなステムでも判定される", () => {
    const reference = new Float32Array(10).fill(1);
    const frames = estimateChordFrames(chromas, judgeEnergies, FD, {
      mode: "song-referenced",
      referenceEnergies: reference,
    });
    expect(chordsOf(frames)).toEqual(Array(10).fill("C"));
  });

  it("song-referenced: 曲全体も静かな瞬間は落ちたままになる", () => {
    // 参照も後半が静か（ただしフレーム 5 だけは鳴っている）
    const reference = new Float32Array([
      1, 1, 1, 1, 1, 1, 0.05, 0.05, 0.05, 0.05,
    ]);
    const frames = estimateChordFrames(chromas, judgeEnergies, FD, {
      mode: "song-referenced",
      referenceEnergies: reference,
    });
    expect(chordsOf(frames)).toEqual([
      "C", "C", "C", "C", "C", "C",
      "N.C.", "N.C.", "N.C.", "N.C.",
    ]);
  });

  it("song-referenced: 絶対下限（1e-4）未満のフレームは救済されない", () => {
    const judge = new Float32Array(judgeEnergies);
    judge[7] = 1e-5;
    const reference = new Float32Array(10).fill(1);
    const frames = estimateChordFrames(chromas, judge, FD, {
      mode: "song-referenced",
      referenceEnergies: reference,
    });
    expect(frames[7].chord).toBe("N.C.");
    expect(frames[6].chord).toBe("C");
  });

  it("song-referenced: 救済フロア比率を上げると床未満のフレームは落ちる", () => {
    const reference = new Float32Array(10).fill(1);
    const rescued = estimateChordFrames(chromas, judgeEnergies, FD, {
      mode: "song-referenced",
      referenceEnergies: reference,
      rescueFloorRatio: 0.03, // 床 = 1.0 × 0.03 = 0.03 <= 0.05
    });
    expect(rescued[5].chord).toBe("C");
    const floored = estimateChordFrames(chromas, judgeEnergies, FD, {
      mode: "song-referenced",
      referenceEnergies: reference,
      rescueFloorRatio: 0.1, // 床 = 0.10 > 0.05
    });
    expect(floored[5].chord).toBe("N.C.");
  });

  it("song-referenced: 救済されても信頼ゲート（0.55）で落ちるフレームは N.C.", () => {
    const flat = new Float32Array(12).fill(1 / 12);
    const mixed = chromas.map((c, i) => (i >= 5 ? flat : c));
    const reference = new Float32Array(10).fill(1);
    const frames = estimateChordFrames(mixed, judgeEnergies, FD, {
      mode: "song-referenced",
      referenceEnergies: reference,
    });
    expect(chordsOf(frames).slice(5)).toEqual(Array(5).fill("N.C."));
  });

  it("song-referenced: 参照が判定経路と同一なら legacy と完全一致する（帰着）", () => {
    const legacy = estimateChordFrames(chromas, judgeEnergies, FD);
    const song = estimateChordFrames(chromas, judgeEnergies, FD, {
      mode: "song-referenced",
      referenceEnergies: judgeEnergies,
    });
    expect(song).toEqual(legacy);
  });

  it("song-referenced: 参照エネルギーが無い場合は legacy として動く", () => {
    const legacy = estimateChordFrames(chromas, judgeEnergies, FD);
    const noRef = estimateChordFrames(chromas, judgeEnergies, FD, {
      mode: "song-referenced",
    });
    expect(noRef).toEqual(legacy);
  });
});

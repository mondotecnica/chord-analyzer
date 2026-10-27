import { describe, expect, it } from "vitest";
import { matchChord } from "./chordEstimation";

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

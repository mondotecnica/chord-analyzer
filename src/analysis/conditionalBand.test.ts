import { describe, expect, it } from "vitest";
import {
  applyConditionalUpperRoot,
  assessCollapseSignature,
  collapseSignatureFires,
  type BandCandidate,
} from "./conditionalBand";
import { displayChordName } from "../lib/chordDisplay";
import type { ChordSegment } from "../types";

const FRAME_DURATION = 0.05;
const NUM_FRAMES = 20; // 1 秒ぶん

/** 全フレーム同じクロマ */
function chromaFrames(vector: Partial<Record<number, number>>): Float32Array[] {
  return Array.from({ length: NUM_FRAMES }, () => {
    const f = new Float32Array(12);
    for (const [pc, v] of Object.entries(vector)) {
      if (v !== undefined) f[Number(pc)] = v;
    }
    return f;
  });
}

/** 全フレーム同じ低域分布（指定 pc に質量を集中させる） */
function bassFramesOn(pc: number, total = 1): Float32Array[] {
  return Array.from({ length: NUM_FRAMES }, () => {
    const f = new Float32Array(12);
    f[pc] = total;
    return f;
  });
}

const energies = new Float32Array(NUM_FRAMES).fill(1);
const zeroUpper = Array.from({ length: NUM_FRAMES }, () => new Float32Array(12));

function seg(chord: string, extra?: Partial<ChordSegment>): ChordSegment {
  return { id: 0, start: 0, end: 1, chord, confidence: 0.7, ...extra };
}

/** G major 的な上帯域クロマ（G, B, D） */
const upperG = chromaFrames({ 7: 0.55, 11: 0.5, 2: 0.45 });

describe("collapseSignatureFires（純粋述語）", () => {
  const cand: BandCandidate = { root: 7, mode: "major", score: 0.95 };
  const base = {
    bassStrong: true,
    bassTopPc: 11, // B（検出ルート Bm のルートであり、候補 G の 3rd）
    detectedRoot: 11,
    candidate: cand,
    upperBandGap: 0.3,
  };

  it("全条件が揃えば発火する", () => {
    expect(collapseSignatureFires(base)).toBe(true);
  });

  it("低域の証拠が弱ければ発火しない", () => {
    expect(collapseSignatureFires({ ...base, bassStrong: false })).toBe(false);
  });

  it("ベース音が検出ルートと異なれば発火しない（健全な分数コード側）", () => {
    expect(collapseSignatureFires({ ...base, bassTopPc: 4 })).toBe(false);
  });

  it("候補が無ければ発火しない", () => {
    expect(collapseSignatureFires({ ...base, candidate: null })).toBe(false);
  });

  it("候補ルートが検出ルートと同じなら発火しない", () => {
    expect(
      collapseSignatureFires({
        ...base,
        candidate: { root: 11, mode: "minor", score: 0.95 },
      }),
    ).toBe(false);
  });

  it("ベース音が候補の構成音でなければ発火しない（相対調への流れを除外）", () => {
    // 候補 F#m に対してベース D は構成音ではない
    expect(
      collapseSignatureFires({
        bassStrong: true,
        bassTopPc: 2,
        detectedRoot: 2,
        candidate: { root: 6, mode: "minor", score: 0.95 },
        upperBandGap: 0.3,
      }),
    ).toBe(false);
  });

  it("上帯域スコア差がしきい値未満なら発火しない", () => {
    expect(collapseSignatureFires({ ...base, upperBandGap: 0.05 })).toBe(false);
  });
});

describe("applyConditionalUpperRoot（Phase 1.5b 条件分岐）", () => {
  it("Song D 型の崩壊（G/B が Bm と検出）ではルートを上帯域候補 G に決め直し、分数表示になる", () => {
    const input = seg("Bm", { bassPc: 11, confidence: 0.42 });
    const [out] = applyConditionalUpperRoot(
      [input],
      upperG,
      bassFramesOn(11),
      energies,
      FRAME_DURATION,
    );
    expect(out.chord).toBe("G");
    expect(out.bassPc).toBe(11); // ベースは保持される
    expect(out.confidence).toBe(0.42);
    expect(displayChordName(out.chord, out.bassPc)).toBe("G/B");
    expect(input.chord).toBe("Bm"); // 入力は不変
  });

  it("健全なセグメント（候補ルート＝検出ルート）では発火しない", () => {
    const input = seg("G", { bassPc: 7 });
    const [out] = applyConditionalUpperRoot(
      [input],
      upperG,
      bassFramesOn(7),
      energies,
      FRAME_DURATION,
    );
    expect(out).toBe(input);
  });

  it("ベース音が候補の構成音でない場合は発火しない（Dm に対する F#m 候補）", () => {
    const upperFsharpM = chromaFrames({ 6: 0.55, 9: 0.5, 1: 0.45 });
    const input = seg("Dm", { bassPc: 2 });
    const [out] = applyConditionalUpperRoot(
      [input],
      upperFsharpM,
      bassFramesOn(2),
      energies,
      FRAME_DURATION,
    );
    expect(out.chord).toBe("Dm");
  });

  it("ベース音が検出ルートと異なる（健全な分数コード C/E 型）場合は発火しない", () => {
    const upperE = chromaFrames({ 4: 0.55, 7: 0.5, 11: 0.45 }); // Em 的
    const input = seg("C", { bassPc: 4 });
    const [out] = applyConditionalUpperRoot(
      [input],
      upperE,
      bassFramesOn(4),
      energies,
      FRAME_DURATION,
    );
    expect(out.chord).toBe("C");
  });

  it("上帯域に証拠が無い（全ゼロ）場合は発火しない", () => {
    const input = seg("Bm", { bassPc: 11 });
    const a = assessCollapseSignature(input, zeroUpper, bassFramesOn(11), 1, energies, FRAME_DURATION);
    expect(a?.candidate).toBeNull();
    expect(a?.fires).toBe(false);
    const [out] = applyConditionalUpperRoot(
      [input],
      zeroUpper,
      bassFramesOn(11),
      energies,
      FRAME_DURATION,
    );
    expect(out.chord).toBe("Bm");
  });

  it("候補は G でもスコア差が小さい場合は発火しない", () => {
    // G と Bm の中間的なクロマ: 候補は G が勝つが差はしきい値未満
    const upperMixed = chromaFrames({ 7: 0.55, 11: 0.5, 2: 0.45, 6: 0.42 });
    const input = seg("Bm", { bassPc: 11 });
    const a = assessCollapseSignature(input, upperMixed, bassFramesOn(11), 1, energies, FRAME_DURATION);
    expect(a?.candidate?.root).toBe(7);
    expect(a?.fires).toBe(false);
    const [out] = applyConditionalUpperRoot(
      [input],
      upperMixed,
      bassFramesOn(11),
      energies,
      FRAME_DURATION,
    );
    expect(out.chord).toBe("Bm");
  });

  it("低域の証拠が弱い（分布が割れている）場合は発火しない", () => {
    const weakBass = Array.from({ length: NUM_FRAMES }, (_, i) => {
      const f = new Float32Array(12);
      f[i % 2 === 0 ? 11 : 0] = 1; // B と C に半々 → マージン 0 で strong にならない
      return f;
    });
    const input = seg("Bm", { bassPc: 11 });
    const [out] = applyConditionalUpperRoot(
      [input],
      upperG,
      weakBass,
      energies,
      FRAME_DURATION,
    );
    expect(out.chord).toBe("Bm");
  });

  it("N.C. セグメントは対象外", () => {
    const input = seg("N.C.", { confidence: 0 });
    const [out] = applyConditionalUpperRoot(
      [input],
      upperG,
      bassFramesOn(11),
      energies,
      FRAME_DURATION,
    );
    expect(out.chord).toBe("N.C.");
  });
});

describe("applyConditionalUpperRoot と Phase 3.2 層フィールドの整合", () => {
  it("決め直した候補が upperChord と一致すれば層を保持する", () => {
    const input = seg("Bm", { bassPc: 11, upperChord: "G" });
    const [out] = applyConditionalUpperRoot(
      [input],
      upperG,
      bassFramesOn(11),
      energies,
      FRAME_DURATION,
    );
    expect(out.chord).toBe("G");
    expect(out.upperChord).toBe("G");
  });

  it("決め直した候補が upperChord と食い違えば層を落とす", () => {
    const input = seg("Bm", { bassPc: 11, upperChord: "D" });
    const [out] = applyConditionalUpperRoot(
      [input],
      upperG,
      bassFramesOn(11),
      energies,
      FRAME_DURATION,
    );
    expect(out.chord).toBe("G");
    expect(out.upperChord).toBeUndefined();
    expect(out.upperExtension).toBeUndefined();
  });

  it("発火しないセグメントの層フィールドには触れない", () => {
    const input = seg("G", { bassPc: 7, upperChord: "Em" });
    const [out] = applyConditionalUpperRoot(
      [input],
      upperG,
      bassFramesOn(7),
      energies,
      FRAME_DURATION,
    );
    expect(out.upperChord).toBe("Em");
  });
});

import { describe, expect, it } from "vitest";
import { applyBassCorrection } from "./bassCorrection";
import type { ChordSegment } from "../types";

const FRAME_DURATION = 0.05;
const NUM_FRAMES = 20; // 1 秒ぶん

function oneHotBass(pc: number, total: number): Float32Array[] {
  return Array.from({ length: NUM_FRAMES }, () => {
    const f = new Float32Array(12);
    f[pc] = total;
    return f;
  });
}

function spreadBass(entries: [number, number][]): Float32Array[] {
  return Array.from({ length: NUM_FRAMES }, () => {
    const f = new Float32Array(12);
    for (const [pc, v] of entries) f[pc] = v;
    return f;
  });
}

function chromaFrames(vector: Partial<Record<number, number>>): Float32Array[] {
  return Array.from({ length: NUM_FRAMES }, () => {
    const f = new Float32Array(12).fill(0.02);
    for (const [pc, v] of Object.entries(vector)) {
      if (v !== undefined) f[Number(pc)] = v;
    }
    return f;
  });
}

const energies = new Float32Array(NUM_FRAMES).fill(1);
const baseSegment: ChordSegment = {
  id: 0,
  start: 0,
  end: 1,
  chord: "C",
  confidence: 0.7,
};

describe("applyBassCorrection", () => {
  it("証拠が強くベースが A を指せば、C → Am に補正し bassPc を別フィールドに残す", () => {
    const bass = oneHotBass(9, 100); // A
    // 全帯域クロマは A minor 的（A, C, E）
    const chroma = chromaFrames({ 9: 0.55, 0: 0.5, 4: 0.45 });
    const [seg] = applyBassCorrection([baseSegment], chroma, bass, energies, FRAME_DURATION);
    expect(seg.chord).toBe("Am");
    expect(seg.bassPc).toBe(9);
  });

  it("モードはベースではなく全帯域クロマから決める（A major 的クロマなら A）", () => {
    const bass = oneHotBass(9, 100);
    // 全帯域クロマは A major 的（A, C#, E）
    const chroma = chromaFrames({ 9: 0.55, 1: 0.5, 4: 0.45 });
    const [seg] = applyBassCorrection([baseSegment], chroma, bass, energies, FRAME_DURATION);
    expect(seg.chord).toBe("A");
    expect(seg.bassPc).toBe(9);
  });

  it("証拠が弱い（分布が割れている）場合は Phase 0 の結果を変えない", () => {
    // トップシェア 0.40 < しきい値 0.5 → 補正しない。bassPc の記録だけは残る。
    const bass = spreadBass([
      [9, 40],
      [0, 35],
      [4, 25],
    ]);
    const chroma = chromaFrames({ 9: 0.55, 0: 0.5, 4: 0.45 });
    const [seg] = applyBassCorrection([baseSegment], chroma, bass, energies, FRAME_DURATION);
    expect(seg.chord).toBe("C");
    expect(seg.bassPc).toBe(9);
  });

  it("低域がほぼ無音なら bassPc も付けず、結果を変えない", () => {
    const bass = Array.from({ length: NUM_FRAMES }, () => new Float32Array(12));
    const chroma = chromaFrames({ 9: 0.55, 0: 0.5, 4: 0.45 });
    const [seg] = applyBassCorrection([baseSegment], chroma, bass, energies, FRAME_DURATION);
    expect(seg.chord).toBe("C");
    expect(seg.bassPc).toBeUndefined();
  });

  it("ベースが現在のルートと一致する場合はコード名を変えない", () => {
    const segIn: ChordSegment = { ...baseSegment, chord: "Am" };
    const bass = oneHotBass(9, 100);
    const chroma = chromaFrames({ 9: 0.55, 0: 0.5, 4: 0.45 });
    const [seg] = applyBassCorrection([segIn], chroma, bass, energies, FRAME_DURATION);
    expect(seg.chord).toBe("Am");
    expect(seg.bassPc).toBe(9);
  });

  it("ベースが構成音（3rd）でクロマが検出コードを支持すれば、分数コードとして補正しない（Step 2 ゲート）", () => {
    // C コードにベース E（3rd）。候補 Em のクロマスコアは C に大きく劣るため、
    // ルートは変えず bassPc だけを残す（表示側で C/E になる）。
    const bass = oneHotBass(4, 100); // E
    const chroma = chromaFrames({ 0: 0.55, 4: 0.5, 7: 0.45 }); // C major 的
    const [seg] = applyBassCorrection([baseSegment], chroma, bass, energies, FRAME_DURATION);
    expect(seg.chord).toBe("C");
    expect(seg.bassPc).toBe(4);
  });

  it("ベースが構成音（短3度）でも、クロマが候補をほぼ同等に支持すれば補正する（相対調 Am → C）", () => {
    const segIn: ChordSegment = { ...baseSegment, chord: "Am" };
    const bass = oneHotBass(0, 100); // C（Am の短3度＝構成音）
    // 全帯域クロマは C major 的（候補 C が検出 Am を大きく上回る）
    const chroma = chromaFrames({ 0: 0.55, 4: 0.5, 7: 0.45 });
    const [seg] = applyBassCorrection([segIn], chroma, bass, energies, FRAME_DURATION);
    expect(seg.chord).toBe("C");
    expect(seg.bassPc).toBe(0);
  });

  it("N.C. セグメントは補正しない", () => {
    const segIn: ChordSegment = { ...baseSegment, chord: "N.C.", confidence: 0 };
    const bass = oneHotBass(9, 100);
    const chroma = chromaFrames({ 9: 0.55, 0: 0.5, 4: 0.45 });
    const [seg] = applyBassCorrection([segIn], chroma, bass, energies, FRAME_DURATION);
    expect(seg.chord).toBe("N.C.");
  });
});

describe("applyBassCorrection の Phase 3.2 層記録（upperChord）", () => {
  it("ルートを潰す補正が発火したら、補正前の読みを upperChord に残す", () => {
    const bass = oneHotBass(9, 100); // A
    const chroma = chromaFrames({ 9: 0.55, 0: 0.5, 4: 0.45 });
    const segIn: ChordSegment = {
      id: 0,
      start: 0,
      end: 1,
      chord: "C",
      confidence: 0.7,
    };
    const [seg] = applyBassCorrection([segIn], chroma, bass, energies, FRAME_DURATION);
    expect(seg.chord).toBe("Am");
    expect(seg.upperChord).toBe("C");
    expect(seg.bassPc).toBe(9);
  });

  it("補正が発火しなければ upperChord は付かない", () => {
    const bass = spreadBass([
      [9, 40],
      [0, 35],
      [4, 25],
    ]);
    const chroma = chromaFrames({ 9: 0.55, 0: 0.5, 4: 0.45 });
    const segIn: ChordSegment = {
      id: 0,
      start: 0,
      end: 1,
      chord: "C",
      confidence: 0.7,
    };
    const [seg] = applyBassCorrection([segIn], chroma, bass, energies, FRAME_DURATION);
    expect(seg.chord).toBe("C");
    expect(seg.upperChord).toBeUndefined();
  });
});

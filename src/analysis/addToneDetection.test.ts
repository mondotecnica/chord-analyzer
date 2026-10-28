import { describe, expect, it } from "vitest";
import { applyAddTones } from "./addToneDetection";
import type { ChordSegment } from "../types";

/**
 * Phase 3.2: add9 付加音検出（addToneDetection）の単体テスト。
 * 証拠フレームは定数ベクトルで与える（シェア＝ベクトル値、
 * 持続性は 0.04 以上の音が 1.0）。
 */

const FRAME_DURATION = 0.05;

function framesFor(
  spans: { vector: Partial<Record<number, number>>; frames: number }[],
): { frames: Float32Array[]; energies: Float32Array } {
  const frames: Float32Array[] = [];
  for (const span of spans) {
    for (let i = 0; i < span.frames; i++) {
      const f = new Float32Array(12);
      for (const [pc, v] of Object.entries(span.vector)) {
        if (v !== undefined) f[Number(pc)] = v;
      }
      frames.push(f);
    }
  }
  return { frames, energies: new Float32Array(frames.length).fill(1) };
}

function seg(extra: Partial<ChordSegment>): ChordSegment {
  return { id: 0, start: 0, end: 1, chord: "C", confidence: 0.7, ...extra };
}

/** C メジャー＋9th（D）の証拠 */
const cAdd9 = { 0: 0.3, 4: 0.28, 7: 0.24, 2: 0.18 };

describe("applyAddTones", () => {
  it("9th 音のシェアと持続性が十分なら add9 を付ける", () => {
    const { frames, energies } = framesFor([{ vector: cAdd9, frames: 20 }]);
    const [out] = applyAddTones([seg({})], frames, energies, FRAME_DURATION);
    expect(out.addTones).toEqual(["add9"]);
  });

  it("対象コードに 7th 拡張がある場合は付けない（その音は 9th）", () => {
    const { frames, energies } = framesFor([{ vector: cAdd9, frames: 20 }]);
    const [out] = applyAddTones(
      [seg({ extension: "7" })],
      frames,
      energies,
      FRAME_DURATION,
    );
    expect(out.addTones).toBeUndefined();
  });

  it("9th 音がベース音そのものなら付けない（ベース層の音）", () => {
    const { frames, energies } = framesFor([{ vector: cAdd9, frames: 20 }]);
    const [out] = applyAddTones(
      [seg({ bassPc: 2 })],
      frames,
      energies,
      FRAME_DURATION,
    );
    expect(out.addTones).toBeUndefined();
  });

  it("短すぎるセグメントには付けない（前後の滲み対策）", () => {
    const { frames, energies } = framesFor([{ vector: cAdd9, frames: 20 }]);
    const [out] = applyAddTones(
      [seg({ start: 0, end: 0.3 })],
      frames,
      energies,
      FRAME_DURATION,
    );
    expect(out.addTones).toBeUndefined();
  });

  it("背景シェアが高い（曲の随所で鳴る音）場合は割り引かれて付かない", () => {
    // C 区間: D シェア 0.15。F 区間×3: D シェア 0.13（F の構成音ではない）
    // → 背景 0.13、割り引き後 0.15 − 0.065 = 0.085 < 0.11 で不発
    const cVec = { 0: 0.32, 4: 0.29, 7: 0.24, 2: 0.15 };
    const fVec = { 5: 0.3, 9: 0.28, 0: 0.24, 2: 0.13, 4: 0.05 };
    const { frames, energies } = framesFor([
      { vector: cVec, frames: 20 },
      { vector: fVec, frames: 60 },
    ]);
    const segs = [
      seg({ id: 0, start: 0, end: 1, chord: "C" }),
      seg({ id: 1, start: 1, end: 4, chord: "F" }),
    ];
    const [outC] = applyAddTones(segs, frames, energies, FRAME_DURATION);
    expect(outC.addTones).toBeUndefined();
  });

  it("背景シェアが低ければ同じ C 区間でも付く（上のケースの対照）", () => {
    const cVec = { 0: 0.32, 4: 0.29, 7: 0.24, 2: 0.15 };
    const fVec = { 5: 0.32, 9: 0.3, 0: 0.26, 2: 0.02, 4: 0.1 };
    const { frames, energies } = framesFor([
      { vector: cVec, frames: 20 },
      { vector: fVec, frames: 60 },
    ]);
    const segs = [
      seg({ id: 0, start: 0, end: 1, chord: "C" }),
      seg({ id: 1, start: 1, end: 4, chord: "F" }),
    ];
    const [outC] = applyAddTones(segs, frames, energies, FRAME_DURATION);
    expect(outC.addTones).toEqual(["add9"]);
  });

  it("判定対象は上層（upperChord）であり、ベース音と重なる 9th は数えない", () => {
    // 上層 Am（9th = B）、ベース C#。B シェア 0.20 で発火する
    const amVec = { 9: 0.3, 0: 0.26, 4: 0.24, 11: 0.2 };
    const { frames, energies } = framesFor([{ vector: amVec, frames: 20 }]);
    const [out] = applyAddTones(
      [seg({ chord: "C#m", upperChord: "Am", bassPc: 1 })],
      frames,
      energies,
      FRAME_DURATION,
    );
    expect(out.addTones).toEqual(["add9"]);
  });

  it("N.C. と edited には付けない", () => {
    const { frames, energies } = framesFor([{ vector: cAdd9, frames: 20 }]);
    const [nc, ed] = applyAddTones(
      [seg({ chord: "N.C." }), seg({ edited: true })],
      frames,
      energies,
      FRAME_DURATION,
    );
    expect(nc.addTones).toBeUndefined();
    expect(ed.addTones).toBeUndefined();
  });
});

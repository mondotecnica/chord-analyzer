import { describe, expect, it } from "vitest";
import { applyUpperLayerReRead } from "./layerChord";
import type { ChordSegment } from "../types";

/**
 * Phase 3.2: 上層再読（layerChord）の単体テスト。
 * 証拠フレームは全フレーム同一の L1 正規化済みシェアベクトルで与える
 * （segmentEvidence はエネルギー加重平均なので、定数フレームでは
 * シェア＝ベクトルそのもの、持続性は 0.04 以上の音が 1.0 になる）。
 */

const FRAME_DURATION = 0.05;
const NUM_FRAMES = 20; // 1 秒ぶん

function frames(vector: Partial<Record<number, number>>): Float32Array[] {
  return Array.from({ length: NUM_FRAMES }, () => {
    const f = new Float32Array(12);
    for (const [pc, v] of Object.entries(vector)) {
      if (v !== undefined) f[Number(pc)] = v;
    }
    return f;
  });
}

const energies = new Float32Array(NUM_FRAMES).fill(1);

function seg(extra: Partial<ChordSegment>): ChordSegment {
  return { id: 0, start: 0, end: 1, chord: "C", confidence: 0.7, ...extra };
}

describe("applyUpperLayerReRead", () => {
  it("真の層（Suno Q1 型）: 補正後 Dm では説明できない C の響きを層として残す", () => {
    const input = seg({ chord: "Dm", upperChord: "C", bassPc: 2 });
    const [out] = applyUpperLayerReRead(
      [input],
      frames({ 2: 0.3, 0: 0.24, 4: 0.22, 7: 0.22, 5: 0.01, 9: 0.01 }),
      energies,
      FRAME_DURATION,
    );
    expect(out.upperChord).toBe("C");
    expect(out.upperExtension).toBeUndefined();
    expect(out.chord).toBe("Dm"); // 第1段のラベルには触れない
    expect(out.bassPc).toBe(2);
  });

  it("相対調の取り違え（補正後 Am が完全適合）では層を落とす", () => {
    const input = seg({ chord: "Am", upperChord: "G", bassPc: 9 });
    const [out] = applyUpperLayerReRead(
      [input],
      frames({ 9: 0.34, 0: 0.33, 4: 0.33 }),
      energies,
      FRAME_DURATION,
    );
    expect(out.upperChord).toBeUndefined();
    expect(out.chord).toBe("Am");
  });

  it("ベース音の 3rd/5th が支配的な証拠では、最良の上層読みへ置き換わる", () => {
    // 補正後 Gm・保持読み Am。証拠は D の 3rd/5th（F# + A）が支配的。
    // ベース音を除いた集計では D メジャーと F#m が同点になる
    // （異なるのは除かれた D と不在の C# だけ）ため、テンプレート
    // 適合は上層として読める F#m を返し、層は F#m/D として残る
    // （D6 / Dmaj7 系の響きの別表記であり、原理的限界の範囲）。
    const input = seg({ chord: "Gm", upperChord: "Am", bassPc: 2 });
    const [out] = applyUpperLayerReRead(
      [input],
      frames({ 2: 0.3, 6: 0.28, 9: 0.28, 0: 0.08, 4: 0.06 }),
      energies,
      FRAME_DURATION,
    );
    expect(out.upperChord).toBe("F#m");
  });

  it("保持読みが証拠に合えば置き換わらない（上のケースの対照）", () => {
    const input = seg({ chord: "Gm", upperChord: "Am", bassPc: 2 });
    const [out] = applyUpperLayerReRead(
      [input],
      frames({ 2: 0.3, 9: 0.28, 0: 0.2, 4: 0.19, 6: 0.03 }),
      energies,
      FRAME_DURATION,
    );
    expect(out.upperChord).toBe("Am");
  });

  it("再読で上層を置き換える（Suno Q4 型: Em 保持 → CM7）", () => {
    const input = seg({ chord: "C#m", upperChord: "Em", bassPc: 1 });
    const [out] = applyUpperLayerReRead(
      [input],
      frames({ 0: 0.26, 4: 0.24, 7: 0.22, 11: 0.16, 1: 0.06, 2: 0.03, 9: 0.03 }),
      energies,
      FRAME_DURATION,
    );
    expect(out.upperChord).toBe("C");
    expect(out.upperExtension).toBe("maj7");
    expect(out.chord).toBe("C#m");
  });

  it("maj7 の再読には高めの床がかかる（3 倍音の F# 0.12 では GM7 化しない）", () => {
    const input = seg({ chord: "Dm", upperChord: "C", bassPc: 2 });
    const [out] = applyUpperLayerReRead(
      [input],
      frames({ 0: 0.26, 4: 0.24, 7: 0.22, 6: 0.12, 2: 0.1, 9: 0.06 }),
      energies,
      FRAME_DURATION,
    );
    expect(out.upperChord).toBe("C");
    expect(out.upperExtension).toBeUndefined();
  });

  it("upperChord の無いセグメントと edited セグメントには触れない", () => {
    const plain = seg({ chord: "C", bassPc: 0 });
    const edited = seg({ chord: "Dm", upperChord: "C", bassPc: 2, edited: true });
    const [a, b] = applyUpperLayerReRead(
      [plain, edited],
      frames({ 2: 0.3, 0: 0.24, 4: 0.22, 7: 0.22 }),
      energies,
      FRAME_DURATION,
    );
    expect(a).toBe(plain);
    expect(b).toBe(edited);
  });
});

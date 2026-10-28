import { describe, expect, it } from "vitest";
import type { ChordSegment } from "../types";
import {
  applyExtensions,
  isDiatonicExtension,
  judgeExtension,
  segmentEvidence,
} from "./extensionDetection";

/** ピッチクラス → シェアのマップから証拠オブジェクトを作る */
function evidence(sharesMap: Record<number, number>, persistence = 1) {
  const shares = new Float32Array(12);
  const persist = new Float32Array(12);
  for (let p = 0; p < 12; p++) {
    shares[p] = sharesMap[p] ?? 0.01;
    persist[p] = persistence;
  }
  return { shares, persistence: persist };
}

// ピッチクラス: C=0 C#=1 D=2 D#=3 E=4 F=5 F#=6 G=7 G#=8 A=9 A#=10 B=11

describe("judgeExtension（第2段の単体判定）", () => {
  it("CM7: 長7度のシェアが強ければ maj7", () => {
    const ev = evidence({ 0: 0.3, 4: 0.25, 7: 0.2, 11: 0.15 });
    expect(judgeExtension("C", 0, ev)).toEqual({ extension: "maj7" });
  });

  it("C7: 短7度が強ければ dom7、maj7 と取り違えない", () => {
    const ev = evidence({ 0: 0.3, 4: 0.25, 7: 0.2, 10: 0.16, 11: 0.02 });
    expect(judgeExtension("C", 0, ev)).toEqual({ extension: "7" });
  });

  it("三和音だけの証拠では拡張を付けない", () => {
    const ev = evidence({ 0: 0.35, 4: 0.3, 7: 0.25, 11: 0.01, 10: 0.02 });
    expect(judgeExtension("C", 0, ev)).toEqual({});
  });

  it("Am7: minor コアに短7度で m7", () => {
    const ev = evidence({ 9: 0.3, 0: 0.25, 4: 0.2, 7: 0.14 });
    expect(judgeExtension("Am", 9, ev)).toEqual({ extension: "m7" });
  });

  it("E7（ドミナント）: E コアに D（♭7）が立てば dom7", () => {
    const ev = evidence({ 4: 0.3, 8: 0.22, 11: 0.18, 2: 0.12 });
    expect(judgeExtension("E", 4, ev)).toEqual({ extension: "7" });
  });

  it("持続性が無い 7th 音（経過音的な一瞬）は付けない", () => {
    const ev = evidence({ 0: 0.3, 4: 0.25, 7: 0.2, 11: 0.15 }, 0.1);
    expect(judgeExtension("C", 0, ev)).toEqual({});
  });

  it("7th ハイジャック再解釈: A と読まれた B7 をベース証拠で B7 に戻す", () => {
    // B7 の構成音（B D# F# A）が支配的で、ベースは B
    const ev = evidence({ 9: 0.18, 6: 0.16, 11: 0.12, 3: 0.1, 4: 0.12, 1: 0.05 });
    expect(judgeExtension("A", 11, ev)).toEqual({
      extension: "7",
      rootOverride: 11,
    });
  });

  it("再解釈はベース証拠が無い／合わない場合は発火しない", () => {
    const ev = evidence({ 9: 0.18, 6: 0.16, 11: 0.12, 3: 0.1, 4: 0.12, 1: 0.05 });
    expect(judgeExtension("A", undefined, ev).rootOverride).toBeUndefined();
    expect(judgeExtension("A", 9, ev).rootOverride).toBeUndefined();
  });

  it("N.C. には何も付けない", () => {
    const ev = evidence({ 0: 0.3, 4: 0.25, 7: 0.2, 11: 0.15 });
    expect(judgeExtension("N.C.", undefined, ev)).toEqual({});
  });
});

describe("isDiatonicExtension（柔らかい prior の判定）", () => {
  const cMaj = { keyRoot: 0, keyMode: "major" as const };
  const aMin = { keyRoot: 9, keyMode: "minor" as const };
  it("C major: CM7(I) / Fmaj7(IV) / G7(V) / Dm7(ii) / Am7(vi) がダイアトニック", () => {
    expect(isDiatonicExtension(0, "maj7", cMaj)).toBe(true);
    expect(isDiatonicExtension(5, "maj7", cMaj)).toBe(true);
    expect(isDiatonicExtension(7, "7", cMaj)).toBe(true);
    expect(isDiatonicExtension(2, "m7", cMaj)).toBe(true);
    expect(isDiatonicExtension(9, "m7", cMaj)).toBe(true);
    expect(isDiatonicExtension(11, "7", cMaj)).toBe(false); // B7 は二次ドミナント側
  });
  it("A minor: Am7(i) / E7(V) / CM7(III) がダイアトニック", () => {
    expect(isDiatonicExtension(9, "m7", aMin)).toBe(true);
    expect(isDiatonicExtension(4, "7", aMin)).toBe(true);
    expect(isDiatonicExtension(0, "maj7", aMin)).toBe(true);
    expect(isDiatonicExtension(11, "7", aMin)).toBe(false); // B7 は V/V
  });
});

describe("judgeExtension の Phase 3.3 文脈 prior（maj7 背景シェア割り引き）", () => {
  const cMaj = { keyRoot: 0, keyMode: "major" as const };
  // B のシェア 0.13: ダイアトニック緩和後しきい値 0.09 は超える
  const ev = evidence({ 0: 0.3, 4: 0.25, 7: 0.2, 11: 0.13 });

  it("背景が無ければ maj7 が付く（3.1 の判定と同一）", () => {
    expect(judgeExtension("C", 0, ev, cMaj)).toEqual({ extension: "maj7" });
  });

  it("背景シェアが高いと maj7 の証拠が割り引かれて付かない", () => {
    // 実効シェア = 0.13 − 0.5 × 0.10 = 0.08 < 0.09
    const ctx = { ...cMaj, contextBackground: 0.1 };
    expect(judgeExtension("C", 0, ev, ctx)).toEqual({});
  });

  it("背景シェアが低ければ maj7 は残る", () => {
    // 実効シェア = 0.13 − 0.5 × 0.02 = 0.12 ≥ 0.09
    const ctx = { ...cMaj, contextBackground: 0.02 };
    expect(judgeExtension("C", 0, ev, ctx)).toEqual({ extension: "maj7" });
  });

  it("割り引きは maj7 のみ（dom7 の判定には影響しない）", () => {
    const ev7 = evidence({ 0: 0.3, 4: 0.25, 7: 0.2, 10: 0.16, 11: 0.02 });
    const ctx = { keyRoot: 7, keyMode: "major" as const, contextBackground: 0.2 };
    expect(judgeExtension("C", 0, ev7, ctx)).toEqual({ extension: "7" });
  });
});

describe("applyExtensions（セグメント適用）", () => {
  const frameDuration = 0.05;
  function framesFor(sharesMap: Record<number, number>, n: number): Float32Array[] {
    const frame = new Float32Array(12);
    for (let p = 0; p < 12; p++) frame[p] = sharesMap[p] ?? 0.01;
    let sum = 0;
    for (const x of frame) sum += x;
    for (let p = 0; p < 12; p++) frame[p] /= sum;
    return Array.from({ length: n }, () => frame);
  }
  const energies = new Float32Array(200).fill(1);
  const seg = (over: Partial<ChordSegment>): ChordSegment => ({
    id: 1,
    start: 0,
    end: 5,
    chord: "C",
    confidence: 0.8,
    ...over,
  });

  it("証拠のあるセグメントにだけ extension を付け、他は不変", () => {
    const frames = framesFor({ 0: 0.3, 4: 0.25, 7: 0.2, 11: 0.15 }, 200);
    const out = applyExtensions(
      [seg({}), seg({ id: 2, chord: "N.C." }), seg({ id: 3, edited: true })],
      frames,
      energies,
      frameDuration,
    );
    expect(out[0].extension).toBe("maj7");
    expect(out[0].chord).toBe("C");
    expect(out[1].extension).toBeUndefined();
    expect(out[2].extension).toBeUndefined();
  });

  it("segmentEvidence は端のフレームを落とす（trim）", () => {
    const frames = framesFor({ 0: 0.9, 4: 0.05, 7: 0.05 }, 100);
    // 先頭 10 フレームだけ別内容に差し替える
    for (let i = 0; i < 10; i++) {
      frames[i] = new Float32Array([0.01, 0.01, 0.01, 0.01, 0.01, 0.9, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01]);
    }
    const ev = segmentEvidence(frames, new Float32Array(100).fill(1), 0, 100);
    expect(ev).not.toBeNull();
    // trim（12% = 12 フレーム）で先頭の F 塊が落ち、C が最大に戻る
    expect(ev!.shares[0]).toBeGreaterThan(ev!.shares[5]);
  });
});

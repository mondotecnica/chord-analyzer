import { describe, expect, it } from "vitest";
import { applyUpperBandMode, modeForRootFromBand } from "./splitBand";
import type { ChordSegment } from "../types";

const FRAME_DURATION = 0.05;
const NUM_FRAMES = 20; // 1 秒ぶん

/** 全フレーム同じクロマ（指定 pc 以外は 0） */
function chromaFrames(vector: Partial<Record<number, number>>): Float32Array[] {
  return Array.from({ length: NUM_FRAMES }, () => {
    const f = new Float32Array(12);
    for (const [pc, v] of Object.entries(vector)) {
      if (v !== undefined) f[Number(pc)] = v;
    }
    return f;
  });
}

const energies = new Float32Array(NUM_FRAMES).fill(1);

function seg(chord: string, extra?: Partial<ChordSegment>): ChordSegment {
  return { id: 0, start: 0, end: 1, chord, confidence: 0.7, ...extra };
}

describe("applyUpperBandMode（Phase 1.5 分業のモード決め直し）", () => {
  it("全帯域が minor と言っても、上帯域が major ならモードは major になる（ルートは維持）", () => {
    // セグメントは全帯域＋ベース補正の結果として Am で確定している想定。
    // 上帯域クロマは A major 的（A, C#, E）。
    const upper = chromaFrames({ 9: 0.55, 1: 0.5, 4: 0.45 });
    const [out] = applyUpperBandMode([seg("Am")], upper, energies, FRAME_DURATION);
    expect(out.chord).toBe("A");
  });

  it("上帯域が minor なら major から minor に決め直す", () => {
    // 上帯域クロマは A minor 的（A, C, E）
    const upper = chromaFrames({ 9: 0.55, 0: 0.5, 4: 0.45 });
    const [out] = applyUpperBandMode([seg("A")], upper, energies, FRAME_DURATION);
    expect(out.chord).toBe("Am");
  });

  it("ルートは上帯域の最良ルートに引っ張られない（上帯域が Am 的でも C のモード判定だけを行う）", () => {
    // 上帯域クロマ全体としては Am（A, C, E）が最も合う内容だが、
    // 分業ではルート C を固定し、C major（C, E, G）vs C minor（C, Eb, G）
    // の比較だけをする。E ナチュラルが強いので C major が勝ち、
    // ルートは C のまま変わらない。
    const upper = chromaFrames({ 9: 0.55, 0: 0.5, 4: 0.45 });
    const [out] = applyUpperBandMode([seg("C")], upper, energies, FRAME_DURATION);
    expect(out.chord).toBe("C");
  });

  it("N.C. セグメントは決め直さない", () => {
    const upper = chromaFrames({ 9: 0.55, 1: 0.5, 4: 0.45 });
    const [out] = applyUpperBandMode(
      [seg("N.C.", { confidence: 0 })],
      upper,
      energies,
      FRAME_DURATION,
    );
    expect(out.chord).toBe("N.C.");
  });

  it("上帯域に証拠が無い（全ゼロ）場合は全帯域側のモードを維持する", () => {
    const upper = Array.from({ length: NUM_FRAMES }, () => new Float32Array(12));
    const [out] = applyUpperBandMode([seg("Am")], upper, energies, FRAME_DURATION);
    expect(out.chord).toBe("Am");
  });

  it("上帯域に 3 度の情報が無い（ルートと 5 度のみ）場合は引き分けとして維持する", () => {
    // A と E のみ: A major / A minor テンプレートへの一致度は同点になる
    const upper = chromaFrames({ 9: 0.6, 4: 0.5 });
    expect(modeForRootFromBand(upper, energies, 0, NUM_FRAMES, 9)).toBeNull();
    const [out] = applyUpperBandMode([seg("Am")], upper, energies, FRAME_DURATION);
    expect(out.chord).toBe("Am");
  });

  it("bassPc・信頼度・境界は変えず、入力セグメントも変更しない", () => {
    const input = seg("Am", { bassPc: 4, confidence: 0.42 });
    const upper = chromaFrames({ 9: 0.55, 1: 0.5, 4: 0.45 });
    const [out] = applyUpperBandMode([input], upper, energies, FRAME_DURATION);
    expect(out.chord).toBe("A");
    expect(out.bassPc).toBe(4);
    expect(out.confidence).toBe(0.42);
    expect(out.start).toBe(0);
    expect(out.end).toBe(1);
    expect(input.chord).toBe("Am"); // 入力は不変
  });

  it("モードが変わらない場合は同じセグメントオブジェクトを返す", () => {
    const input = seg("A");
    const upper = chromaFrames({ 9: 0.55, 1: 0.5, 4: 0.45 }); // A major 的
    const [out] = applyUpperBandMode([input], upper, energies, FRAME_DURATION);
    expect(out).toBe(input);
  });
});

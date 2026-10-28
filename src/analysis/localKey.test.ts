import { describe, expect, it } from "vitest";
import { rankKeys } from "./keyTempo";
import {
  chordKeyPlausibility,
  estimateLocalKeys,
  localKeyWindowAt,
} from "./localKey";

/** ピッチクラス → 値のマップから 1 フレームを作る（合計は呼び出し側で揃える） */
function frame(map: Record<number, number>): Float32Array {
  const f = new Float32Array(12);
  for (let p = 0; p < 12; p++) f[p] = map[p] ?? 0.01;
  let sum = 0;
  for (const x of f) sum += x;
  for (let p = 0; p < 12; p++) f[p] /= sum;
  return f;
}

describe("estimateLocalKeys（窓滑らしキー推定）", () => {
  it("前半 C major 的・後半 G major 的なクロマで窓が追従する", () => {
    const fd = 0.05;
    const n = 600; // 30 秒
    const frames: Float32Array[] = [];
    const energies = new Float32Array(n).fill(1);
    const cMaj = frame({ 0: 0.3, 4: 0.25, 7: 0.2, 2: 0.08, 9: 0.06 });
    const gMaj = frame({ 7: 0.3, 11: 0.25, 2: 0.2, 4: 0.08, 9: 0.06 });
    for (let i = 0; i < n; i++) frames.push(i < n / 2 ? cMaj : gMaj);
    const ctx = estimateLocalKeys(frames, energies, fd, 30);
    expect(ctx.windows.length).toBeGreaterThanOrEqual(4);
    const first = ctx.windows[0];
    const last = ctx.windows[ctx.windows.length - 1];
    expect(first.root).toBe(0);
    expect(first.mode).toBe("major");
    expect(last.root).toBe(7);
    expect(last.mode).toBe("major");
    // margin / 次点が記録される（曖昧さの可視化が目的）
    expect(first.margin).toBeGreaterThan(0);
    expect(first.runnerUpRoot).toBeDefined();
  });

  it("rankKeys（keyTempo）は 24 キーを相関の降順で返す", () => {
    const agg = frame({ 0: 0.3, 4: 0.25, 7: 0.2, 2: 0.08, 9: 0.06 });
    const ranked = rankKeys(agg);
    expect(ranked).toHaveLength(24);
    expect(ranked[0].root).toBe(0);
    expect(ranked[0].mode).toBe("major");
    for (let i = 1; i < ranked.length; i++) {
      expect(ranked[i - 1].correlation).toBeGreaterThanOrEqual(ranked[i].correlation);
    }
  });

  it("localKeyWindowAt は内包する窓を返し、範囲外では最も近い窓を返す", () => {
    const ctx = {
      global: { root: 0, mode: "major" as const, keyName: "C major", correlation: 0.8, margin: 0.1 },
      windows: [
        { start: 0, end: 12, root: 0, mode: "major" as const, correlation: 0.8, margin: 0.1, runnerUpRoot: 9, runnerUpMode: "minor" as const },
        { start: 12, end: 24, root: 7, mode: "major" as const, correlation: 0.75, margin: 0.05, runnerUpRoot: 4, runnerUpMode: "minor" as const },
      ],
    };
    expect(localKeyWindowAt(ctx, 5)?.root).toBe(0);
    expect(localKeyWindowAt(ctx, 20)?.root).toBe(7);
    expect(localKeyWindowAt(ctx, 100)?.root).toBe(7);
  });
});

describe("chordKeyPlausibility（柔らかい prior の尤もらしさ）", () => {
  it("A minor における Cm は E♭ がスケール外で割り引かれる", () => {
    // C(1.0, スケール内) + E♭(1.0, 外) + G(0.75, 内) → 1.75 / 2.75
    expect(chordKeyPlausibility(0, "minor", 9, "minor")).toBeCloseTo(1.75 / 2.75, 5);
    // 一方 C major は全音スケール内
    expect(chordKeyPlausibility(0, "major", 9, "minor")).toBe(1);
  });

  it("マイナーキーでは V（長三和音）と IV（長三和音）を借用として罰しない", () => {
    // A minor における E major（V）: E, G#(導音として許容), B → 1.0
    expect(chordKeyPlausibility(4, "major", 9, "minor")).toBe(1);
    // D major（IV）: D, F#(高めの6度として許容), A → 1.0
    expect(chordKeyPlausibility(2, "major", 9, "minor")).toBe(1);
  });

  it("音の欠落でなく色の食い違いだけが減点される（根音と5度は等しく扱わない）", () => {
    // B major を A minor で: B(1.0, 内) + D#(1.0, 外) + F#(0.75, 内)
    expect(chordKeyPlausibility(11, "major", 9, "minor")).toBeCloseTo(1.75 / 2.75, 5);
  });
});

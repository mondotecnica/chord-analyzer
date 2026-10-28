import { describe, expect, it } from "vitest";
import type { ChordSegment } from "../types";
import type { LocalKeyContext } from "./localKey";
import { applyLocalKeyModeNudge, judgeModeNudge } from "./localKeyMode";

/** A minor が全体・局所とも最有力（次点 C major は近い）の文脈 */
const ctxAm: LocalKeyContext = {
  global: { root: 9, mode: "minor", keyName: "A minor", correlation: 0.71, margin: 0.06 },
  windows: [
    {
      start: 0, end: 300, root: 9, mode: "minor",
      correlation: 0.72, margin: 0.07, runnerUpRoot: 0, runnerUpMode: "major",
    },
  ],
};

describe("judgeModeNudge（モード prior の単体判定）", () => {
  it("Q2 型 (1): マージン僅少な Cm は A minor 文脈で C に反転する", () => {
    // Suno Q2 stems 152.6–156.1s の実測スコア（maj 0.577 / min 0.590）
    const v = judgeModeNudge(0, "minor", 0.577, 0.590, 0, ctxAm, 154);
    expect(v.flipTo).toBe("major");
    expect(v.plausibilityGap).toBeGreaterThan(0);
  });

  it("Q2 型 (2): E♭ の局所証拠が強い Cm も上限内で反転する", () => {
    // Suno Q2 stems 165.7–167.3s の実測スコア（maj 0.604 / min 0.798）
    const v = judgeModeNudge(0, "minor", 0.604, 0.798, 0, ctxAm, 166);
    expect(v.flipTo).toBe("major");
    expect(v.audioMargin).toBeCloseTo(0.194, 3);
  });

  it("音響マージンが大きい決定は prior では絶対に覆らない", () => {
    const v = judgeModeNudge(0, "minor", 0.3, 0.62, 0, ctxAm, 154);
    expect(v.flipTo).toBeUndefined();
    expect(v.bonus).toBe(0);
  });

  it("キーの下で等しく尤もらしいモード対（A minor の E / Em）は触らない", () => {
    const v = judgeModeNudge(4, "major", 0.5, 0.48, 4, ctxAm, 154);
    expect(v.flipTo).toBeUndefined();
  });

  it("ベースがルートと食い違い構成音でもないセグメントは対象外（Q3 の B7 ハイジャック保護）", () => {
    // Q2 と同じスコア関係でも、ベースが F#（C の構成音でない）なら
    // ルート未確定として触らない
    const v = judgeModeNudge(0, "minor", 0.577, 0.590, 6, ctxAm, 154);
    expect(v.flipTo).toBeUndefined();
    // ベースがルートと一致すれば通常どおり反転する（Q2 型 (1) と同一条件）
    const v2 = judgeModeNudge(0, "minor", 0.577, 0.590, 0, ctxAm, 154);
    expect(v2.flipTo).toBe("major");
    // 参考: Q3 の B7 ハイジャック対象（A major 読み・ベース B）は
    // このガードに加えて二次ドミナント保護（A は D への V/V）でも守られる
    const v3 = judgeModeNudge(9, "major", 0.4, 0.42, 11, ctxAm, 88);
    expect(v3.flipTo).toBeUndefined();
  });

  it("二次ドミナントの形の長三和音は minor へ反転させない", () => {
    // Song E の B7: A minor 文脈で Bm の方が尤もらしいが、B は
    // 解決先 E（スケール音）への二次ドミナントとして説明できる
    const v = judgeModeNudge(11, "major", 0.4, 0.42, 11, ctxAm, 3);
    expect(v.flipTo).toBeUndefined();
    // Song B の D: C major 文脈（次点 A minor）でも D は G への
    // 二次ドミナントとして保護される
    const ctxC: LocalKeyContext = {
      global: { root: 0, mode: "major", keyName: "C major", correlation: 0.8, margin: 0.1 },
      windows: [
        {
          start: 0, end: 300, root: 0, mode: "major",
          correlation: 0.82, margin: 0.08, runnerUpRoot: 9, runnerUpMode: "minor",
        },
      ],
    };
    const v2 = judgeModeNudge(2, "major", 0.4, 0.42, 2, ctxC, 17);
    expect(v2.flipTo).toBeUndefined();
  });

  it("次点キーが反転を支持しない場合は止まる（反対・無関心のどちらでも）", () => {
    // 最有力 A minor は Cm→C を支持するが、次点の E♭ major は
    // Cm を完全に支持し C を割り引く → 文脈が割れているので止める
    const ctxSplit: LocalKeyContext = {
      global: ctxAm.global,
      windows: [
        {
          start: 0, end: 300, root: 9, mode: "minor",
          correlation: 0.72, margin: 0.05, runnerUpRoot: 3, runnerUpMode: "major",
        },
      ],
    };
    expect(judgeModeNudge(0, "minor", 0.577, 0.590, 0, ctxSplit, 154).flipTo).toBeUndefined();
    // 窓のマージンが大きくても扱いは同じ（次点の支持は常に必須）
    const ctxSplitFar: LocalKeyContext = {
      global: ctxAm.global,
      windows: [
        {
          start: 0, end: 300, root: 9, mode: "minor",
          correlation: 0.72, margin: 0.3, runnerUpRoot: 3, runnerUpMode: "major",
        },
      ],
    };
    expect(judgeModeNudge(0, "minor", 0.577, 0.590, 0, ctxSplitFar, 154).flipTo).toBeUndefined();
    // 次点が無関心（gap = 0）な反転も止まる: 実曲1 stems の
    // Dm(maj7) 区間（A major 窓・次点 F# minor では D/Dm とも
    // 完全に尤もらしい）がこの形で、実際に守るべき対象
    const ctxIndifferent: LocalKeyContext = {
      global: { root: 9, mode: "major", keyName: "A major", correlation: 0.8, margin: 0.14 },
      windows: [
        {
          start: 0, end: 300, root: 9, mode: "major",
          correlation: 0.82, margin: 0.14, runnerUpRoot: 6, runnerUpMode: "minor",
        },
      ],
    };
    expect(judgeModeNudge(2, "minor", 0.6, 0.61, 2, ctxIndifferent, 42).flipTo).toBeUndefined();
    // 次点も支持すれば（ctxAm: 次点 C major も Cm→C を支持）反転する
    expect(judgeModeNudge(0, "minor", 0.577, 0.590, 0, ctxAm, 154).flipTo).toBe("major");
  });
});

describe("applyLocalKeyModeNudge（セグメント適用）", () => {
  const frameDuration = 0.05;
  function framesFor(map: Record<number, number>, n: number): Float32Array[] {
    const f = new Float32Array(12);
    for (let p = 0; p < 12; p++) f[p] = map[p] ?? 0.02;
    let sum = 0;
    for (const x of f) sum += x;
    for (let p = 0; p < 12; p++) f[p] /= sum;
    return Array.from({ length: n }, () => f);
  }
  const energies = new Float32Array(200).fill(1);
  const seg = (over: Partial<ChordSegment>): ChordSegment => ({
    id: 1,
    start: 0,
    end: 5,
    chord: "Cm",
    confidence: 0.8,
    bassPc: 0,
    ...over,
  });

  it("接戦の Cm は A minor 文脈で C になる（E♭ と E が拮抗する証拠）", () => {
    const frames = framesFor({ 0: 0.3, 3: 0.14, 4: 0.13, 7: 0.25 }, 200);
    const out = applyLocalKeyModeNudge([seg({})], frames, energies, frameDuration, ctxAm);
    expect(out[0].chord).toBe("C");
    expect(out[0].bassPc).toBe(0); // ルート・ベース・境界は不変
  });

  it("N.C. とユーザー修正済みセグメントは不変", () => {
    const frames = framesFor({ 0: 0.3, 3: 0.14, 4: 0.13, 7: 0.25 }, 200);
    const out = applyLocalKeyModeNudge(
      [seg({ chord: "N.C.", bassPc: undefined }), seg({ id: 2, edited: true })],
      frames,
      energies,
      frameDuration,
      ctxAm,
    );
    expect(out[0].chord).toBe("N.C.");
    expect(out[1].chord).toBe("Cm");
  });
});

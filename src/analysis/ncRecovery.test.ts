import { describe, expect, it } from "vitest";
import { NO_CHORD } from "../lib/notes";
import type { ChordSegment } from "../types";
import {
  applyNcGapFill,
  applyNcSegmentRematch,
  applyNcStemsFallback,
} from "./ncRecovery";

/** テンプレート様のクロマ（root / 3度 / 5度） */
function chordVec(root: number, minor: boolean): Float32Array {
  const v = new Float32Array(12);
  v[root] = 1;
  v[(root + (minor ? 3 : 4)) % 12] = 0.9;
  v[(root + 7) % 12] = 0.75;
  return v;
}

/** 一様クロマ（照合スコアが信頼ゲート未満になる無情報フレーム） */
function flatVec(): Float32Array {
  return new Float32Array(12).fill(1);
}

function bassVec(pc: number): Float32Array {
  const v = new Float32Array(12);
  v[pc] = 1;
  return v;
}

const FD = 0.25; // frameDuration
const N_FRAMES = 16; // 4 秒

function frames(fill: (i: number) => Float32Array): Float32Array[] {
  return Array.from({ length: N_FRAMES }, (_, i) => fill(i));
}

let segSeq = 0;
function seg(chord: string, start: number, end: number, confidence = 0.8): ChordSegment {
  return { id: segSeq++, start, end, chord, confidence };
}

describe("applyNcSegmentRematch", () => {
  // N.C. 区間は 1–3 秒（フレーム 4–11）。判定経路は大半ゲート落ちだが
  // 生き残ったフレームが C を示し、第2視点も C に一致する。
  const baseSegments = [seg("Am", 0, 1), seg(NO_CHORD, 1, 3, 0), seg("Am", 3, 4)];
  const judgeEnergies = new Float32Array(N_FRAMES).fill(1);
  for (let i = 4; i <= 8; i++) judgeEnergies[i] = 0.05;

  it("2視点のルートが一致すれば集計で充填し、出所と低信頼度を付ける", () => {
    const out = applyNcSegmentRematch(baseSegments, {
      judgeFrames: frames(() => chordVec(0, false)),
      judgeEnergies,
      secondFrames: frames(() => chordVec(0, false)),
      secondEnergies: new Float32Array(N_FRAMES).fill(1),
      frameDuration: FD,
      modeFrames: frames(() => chordVec(0, false)),
      bassFrames: null,
    });
    expect(out[1].chord).toBe("C");
    expect(out[1].ncFill).toBe("segment-rematch");
    expect(out[1].confidence).toBeGreaterThan(0);
    expect(out[1].confidence).toBeLessThanOrEqual(0.5);
    // 非 N.C. は不変
    expect(out[0]).toEqual(baseSegments[0]);
    expect(out[2]).toEqual(baseSegments[2]);
  });

  it("第2視点のルートが食い違えば充填しない", () => {
    const out = applyNcSegmentRematch(baseSegments, {
      judgeFrames: frames(() => chordVec(0, false)),
      judgeEnergies,
      secondFrames: frames(() => chordVec(2, false)),
      secondEnergies: new Float32Array(N_FRAMES).fill(1),
      frameDuration: FD,
      modeFrames: frames(() => chordVec(0, false)),
      bassFrames: null,
    });
    expect(out[1].chord).toBe(NO_CHORD);
    expect(out[1].ncFill).toBeUndefined();
  });

  it("判定経路の全フレームがゲート落ちなら充填しない", () => {
    const dead = new Float32Array(N_FRAMES).fill(1);
    for (let i = 4; i <= 11; i++) dead[i] = 0.05;
    const out = applyNcSegmentRematch(baseSegments, {
      judgeFrames: frames(() => chordVec(0, false)),
      judgeEnergies: dead,
      secondFrames: frames(() => chordVec(0, false)),
      secondEnergies: new Float32Array(N_FRAMES).fill(1),
      frameDuration: FD,
      modeFrames: frames(() => chordVec(0, false)),
      bassFrames: null,
    });
    expect(out[1].chord).toBe(NO_CHORD);
  });

  it("両視点とも 95% 以上ゲート落ち（全域無音）は、生存フレームがあっても充填しない", () => {
    // frameDuration 0.1 の 2 秒区間 = 20 フレーム中 19 がゲート落ち
    const n = 40;
    const je = new Float32Array(n).fill(1);
    const se = new Float32Array(n).fill(1);
    for (let i = 10; i < 30; i++) {
      je[i] = 0.05;
      se[i] = 0.05;
    }
    je[15] = 1; // 生存フレームが1つだけある
    const wide = [seg("Am", 0, 1), seg(NO_CHORD, 1, 3, 0), seg("Am", 3, 4)];
    const out = applyNcSegmentRematch(wide, {
      judgeFrames: Array.from({ length: n }, () => chordVec(0, false)),
      judgeEnergies: je,
      secondFrames: Array.from({ length: n }, () => chordVec(0, false)),
      secondEnergies: se,
      frameDuration: 0.1,
      modeFrames: Array.from({ length: n }, () => chordVec(0, false)),
      bassFrames: null,
    });
    expect(out[1].chord).toBe(NO_CHORD);
  });

  it("強いベース証拠が候補の構成音と矛盾すれば棄却し、一致すれば通す", () => {
    const common = {
      judgeFrames: frames(() => chordVec(0, false)),
      judgeEnergies,
      secondFrames: frames(() => chordVec(0, false)),
      secondEnergies: new Float32Array(N_FRAMES).fill(1),
      frameDuration: FD,
      modeFrames: frames(() => chordVec(0, false)),
    };
    // F# (pc 6) は C メジャーの構成音 {0,4,7} に含まれない
    const vetoed = applyNcSegmentRematch(baseSegments, {
      ...common,
      bassFrames: frames(() => bassVec(6)),
    });
    expect(vetoed[1].chord).toBe(NO_CHORD);
    // ルート C (pc 0) は構成音
    const passed = applyNcSegmentRematch(baseSegments, {
      ...common,
      bassFrames: frames(() => bassVec(0)),
    });
    expect(passed[1].chord).toBe("C");
  });

  it("モードが2視点で割れたら上帯域で決め直す", () => {
    const out = applyNcSegmentRematch(baseSegments, {
      judgeFrames: frames(() => chordVec(0, false)), // 判定側は C major
      judgeEnergies,
      secondFrames: frames(() => chordVec(0, true)), // 第2視点は Cm
      secondEnergies: new Float32Array(N_FRAMES).fill(1),
      frameDuration: FD,
      modeFrames: frames(() => chordVec(0, true)), // 上帯域は minor
      bassFrames: null,
    });
    expect(out[1].chord).toBe("Cm");
    expect(out[1].ncFill).toBe("segment-rematch");
  });

  it("短すぎる区間（< 0.5 秒）は対象外", () => {
    const short = [seg("Am", 0, 1), seg(NO_CHORD, 1, 1.3, 0), seg("Am", 1.3, 4)];
    const out = applyNcSegmentRematch(short, {
      judgeFrames: frames(() => chordVec(0, false)),
      judgeEnergies: new Float32Array(N_FRAMES).fill(1),
      secondFrames: frames(() => chordVec(0, false)),
      secondEnergies: new Float32Array(N_FRAMES).fill(1),
      frameDuration: FD,
      modeFrames: frames(() => chordVec(0, false)),
      bassFrames: null,
    });
    expect(out[1].chord).toBe(NO_CHORD);
  });
});

describe("applyNcStemsFallback", () => {
  const baseSegments = [seg("C", 0, 1), seg(NO_CHORD, 1, 3, 0), seg("C", 3, 4)];
  // other は区間の 75% がゲート落ち
  const judgeEnergies = new Float32Array(N_FRAMES).fill(1);
  for (let i = 4; i <= 9; i++) judgeEnergies[i] = 0.05;

  it("other が薄く混合音＋ベースが一致すれば副次証拠で充填する", () => {
    const out = applyNcStemsFallback(baseSegments, {
      judgeEnergies,
      mixFrames: frames(() => chordVec(9, true)), // Am
      mixEnergies: new Float32Array(N_FRAMES).fill(1),
      bassFrames: frames(() => bassVec(9)), // A
      frameDuration: FD,
    });
    expect(out[1].chord).toBe("Am");
    expect(out[1].ncFill).toBe("stems-fallback");
    expect(out[1].bassPc).toBe(9);
    expect(out[1].confidence).toBeLessThanOrEqual(0.45);
  });

  it("強いベースが候補と矛盾すれば充填しない", () => {
    const out = applyNcStemsFallback(baseSegments, {
      judgeEnergies,
      mixFrames: frames(() => chordVec(9, true)),
      mixEnergies: new Float32Array(N_FRAMES).fill(1),
      bassFrames: frames(() => bassVec(2)), // D は Am の構成音でない
      frameDuration: FD,
    });
    expect(out[1].chord).toBe(NO_CHORD);
  });

  it("判定経路に十分なエネルギーがある区間は上書きしない", () => {
    const out = applyNcStemsFallback(baseSegments, {
      judgeEnergies: new Float32Array(N_FRAMES).fill(1),
      mixFrames: frames(() => chordVec(9, true)),
      mixEnergies: new Float32Array(N_FRAMES).fill(1),
      bassFrames: frames(() => bassVec(9)),
      frameDuration: FD,
    });
    expect(out[1].chord).toBe(NO_CHORD);
  });

  it("混合音の集計が不明瞭なら充填しない", () => {
    const out = applyNcStemsFallback(baseSegments, {
      judgeEnergies,
      mixFrames: frames(() => flatVec()),
      mixEnergies: new Float32Array(N_FRAMES).fill(1),
      bassFrames: frames(() => bassVec(9)),
      frameDuration: FD,
    });
    expect(out[1].chord).toBe(NO_CHORD);
  });
});

describe("applyNcGapFill", () => {
  const judgeFrames = frames(() => flatVec());
  const judgeEnergies = new Float32Array(N_FRAMES).fill(1);

  it("両隣が同一コードの短い欠落を充填する", () => {
    const segs = [seg("B", 0, 1, 0.8), seg(NO_CHORD, 1, 1.5, 0), seg("B", 1.5, 2.5, 0.9)];
    const out = applyNcGapFill(segs, judgeFrames, judgeEnergies, FD);
    expect(out[1].chord).toBe("B");
    expect(out[1].ncFill).toBe("gap-fill");
    expect(out[1].confidence).toBeCloseTo(0.45);
  });

  it("長い欠落・両隣が異なる場合は充填しない", () => {
    const long = [seg("B", 0, 1), seg(NO_CHORD, 1, 2.5, 0), seg("B", 2.5, 4)];
    expect(applyNcGapFill(long, judgeFrames, judgeEnergies, FD)[1].chord).toBe(NO_CHORD);
    const diff = [seg("B", 0, 1), seg(NO_CHORD, 1, 1.5, 0), seg("G", 1.5, 2.5)];
    expect(applyNcGapFill(diff, judgeFrames, judgeEnergies, FD)[1].chord).toBe(NO_CHORD);
  });

  it("区間自身の集計が別ルートを強く示す場合は充填しない", () => {
    const segs = [seg("B", 0, 1), seg(NO_CHORD, 1, 1.5, 0), seg("B", 1.5, 2.5)];
    const strong = frames((i) => (i >= 4 && i <= 5 ? chordVec(2, false) : flatVec()));
    const out = applyNcGapFill(segs, strong, judgeEnergies, FD);
    expect(out[1].chord).toBe(NO_CHORD);
  });
});

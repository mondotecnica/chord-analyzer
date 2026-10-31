import { describe, expect, it } from "vitest";
import { NO_CHORD } from "../lib/notes";
import type { ChordSegment, SegmentCandidate } from "../types";
import {
  applyTheoryReevaluation,
  isExplainable,
  keyScaleFit,
  THEORY_WEIGHTS,
  THEORY_WEIGHTS_V2,
  transitionFeature,
  type TheoryProfile,
  type TheoryWeights,
} from "./theoryReevaluation";

function cand(
  root: number,
  mode: "major" | "minor",
  margin: number,
): SegmentCandidate {
  return { root, mode, score: 1 - margin, margin };
}

function seg(
  start: number,
  end: number,
  chord: string,
  candidates?: SegmentCandidate[],
  extra?: Partial<ChordSegment>,
): ChordSegment {
  return {
    id: start,
    start,
    end,
    chord,
    confidence: 0.9,
    ...(candidates ? { candidates } : {}),
    ...extra,
  };
}

const A_MINOR: TheoryProfile = { keyRoot: 9, keyMode: "minor" };
const C_MAJOR: TheoryProfile = { keyRoot: 0, keyMode: "major" };

describe("keyScaleFit", () => {
  it("ダイアトニック三和音は 1、半音の外れは 2/3 になる", () => {
    expect(keyScaleFit(0, "major", 0, "major")).toBe(1); // C in C
    expect(keyScaleFit(2, "minor", 0, "major")).toBe(1); // Dm in C
    expect(keyScaleFit(1, "major", 0, "major")).toBeCloseTo(1 / 3); // C# in C
  });
  it("短調の属和音（V）は和声短音階の例外で 1 になる", () => {
    expect(keyScaleFit(4, "major", 9, "minor")).toBe(1); // E in A minor
    expect(keyScaleFit(11, "major", 9, "minor")).toBeCloseTo(1 / 3); // B in A minor
  });
});

describe("isExplainable", () => {
  it("二次ドミナント・借用・ナポリを説明可能とみなす", () => {
    expect(isExplainable(11, "major", 9, "minor")).toBe(true); // B = V/V in Am
    expect(isExplainable(2, "major", 0, "major")).toBe(true); // D = V/V in C
    expect(isExplainable(5, "minor", 0, "major")).toBe(true); // Fm = borrowed iv in C
    expect(isExplainable(1, "major", 0, "major")).toBe(true); // Db = Neapolitan in C
    expect(isExplainable(0, "minor", 9, "minor")).toBe(false); // Cm in Am: 説明なし
  });
});

describe("transitionFeature", () => {
  it("定型の遷移を評価する", () => {
    // V→I authentic
    expect(transitionFeature({ root: 7, mode: "major" }, { root: 0, mode: "major" }, 0, "major")).toBe(1.0);
    // V/V→V 連鎖（B→E in A minor）
    expect(transitionFeature({ root: 11, mode: "major" }, { root: 4, mode: "major" }, 9, "minor")).toBe(0.9);
    // V→IV は逆行として罰する
    expect(transitionFeature({ root: 7, mode: "major" }, { root: 5, mode: "major" }, 0, "major")).toBe(-0.5);
    // 同一コードの継続
    expect(transitionFeature({ root: 9, mode: "minor" }, { root: 9, mode: "minor" }, 9, "minor")).toBe(0.4);
  });
});

describe("applyTheoryReevaluation", () => {
  it("候補が無いセグメント列はそのまま返す", () => {
    const segs = [seg(0, 2, "C"), seg(2, 4, "G")];
    const out = applyTheoryReevaluation(segs, C_MAJOR);
    expect(out.map((s) => s.chord)).toEqual(["C", "G"]);
    expect(out[0].theoryRationale).toBeUndefined();
  });

  it("N.C. は理論で埋めず、ラベルありは N.C. に落とさない", () => {
    const segs = [
      seg(0, 2, NO_CHORD, [cand(0, "major", 0), cand(9, "minor", 0.01)]),
      seg(2, 4, "C", [cand(0, "major", 0), cand(9, "minor", 0.001)]),
    ];
    const out = applyTheoryReevaluation(segs, C_MAJOR);
    expect(out[0].chord).toBe(NO_CHORD);
    expect(out[1].chord).not.toBe(NO_CHORD);
  });

  it("二次ドミナント連鎖の文脈で次点を格上げする（B7 型）", () => {
    // 実例（stems-05、87.63–89.30 秒）の候補列を再現する:
    // C → [勝者 A / 集計最有力は B] → E → Am（全体キーは A minor）。
    // B は集計で強く優位（負マージン −0.586）で、遷移からも
    // V/V→V の裏付けを得る
    const segs = [
      seg(0, 2, "C", [cand(0, "major", 0), cand(9, "minor", 0.02)]),
      seg(2, 4, "A", [
        cand(9, "major", 0),
        cand(11, "major", -0.586),
        cand(3, "minor", -0.564),
        cand(11, "minor", -0.442),
        cand(2, "major", -0.43),
      ]),
      seg(4, 6, "E", [cand(4, "major", 0), cand(9, "minor", 0.03)]),
      seg(6, 8, "Am", [cand(9, "minor", 0), cand(0, "major", 0.02)]),
    ];
    const out = applyTheoryReevaluation(segs, A_MINOR);
    expect(out[1].chord).toBe("B");
    expect(out[1].theoryRationale).toBeDefined();
    expect(out[1].theoryRationale!.fromRoot).toBe(9);
    expect(out[1].theoryRationale!.acousticMargin).toBeCloseTo(-0.586);
    // 根拠内訳: 遷移（次）の寄与が正、合計は各軸の和に一致する
    const r = out[1].theoryRationale!;
    expect(r.transitionNext).toBeGreaterThan(0);
    expect(out[0].theoryRationale).toBeUndefined();
    expect(out[2].chord).toBe("E");
  });

  it("上限: 生マージンが swingCap 以上の候補へは反転しない", () => {
    // B は理論上は申し分ない（V/V）が、マージンが上限以上に大きい
    const segs = [
      seg(0, 2, "C", [cand(0, "major", 0)]),
      seg(2, 4, "Am", [cand(9, "minor", 0), cand(11, "major", THEORY_WEIGHTS.swingCap + 0.05)]),
      seg(4, 6, "E", [cand(4, "major", 0)]),
    ];
    const out = applyTheoryReevaluation(segs, A_MINOR);
    expect(out[1].chord).toBe("Am");
    expect(out[1].theoryRationale).toBeUndefined();
  });

  it("装飾つきセグメント（拡張音・層表示）は反転から保護する", () => {
    const base = [
      cand(9, "minor", 0),
      cand(11, "major", -0.44),
    ];
    const withExt = [
      seg(0, 2, "C", [cand(0, "major", 0)]),
      seg(2, 4, "Am", base, { extension: "m7" as const }),
      seg(4, 6, "E", [cand(4, "major", 0)]),
    ];
    expect(applyTheoryReevaluation(withExt, A_MINOR)[1].chord).toBe("Am");
    const withUpper = [
      seg(0, 2, "C", [cand(0, "major", 0)]),
      seg(2, 4, "Am", base, { upperChord: "C" }),
      seg(4, 6, "E", [cand(4, "major", 0)]),
    ];
    expect(applyTheoryReevaluation(withUpper, A_MINOR)[1].chord).toBe("Am");
  });

  it("入力を変更しない（純粋関数）", () => {
    const segs = [
      seg(0, 2, "Am", [cand(9, "minor", 0), cand(11, "major", -0.44)]),
      seg(2, 4, "E", [cand(4, "major", 0)]),
    ];
    const snapshot = JSON.stringify(segs);
    applyTheoryReevaluation(segs, A_MINOR);
    expect(JSON.stringify(segs)).toBe(snapshot);
  });

  it("重みの構成: 理論優位の上限が swingCap と一致する", () => {
    expect(
      THEORY_WEIGHTS.key + THEORY_WEIGHTS.diatonic + 4 * THEORY_WEIGHTS.transition,
    ).toBeCloseTo(THEORY_WEIGHTS.swingCap);
  });
});

describe("applyTheoryReevaluation v2（再挑戦の3本柱）", () => {
  it("柱1 floored: 集計の支持（負マージン）だけでは反転しない", () => {
    // 理論的に支持のない代替（F#m: キー適合・遷移とも勝者に劣る）
    // が集計だけで大きく優位でも、v2 では emission が 0 のため
    // 覆らない（v1 では emission の正の支持だけで覆る）
    const segs = [
      seg(0, 2, "C", [cand(0, "major", 0), cand(5, "major", 0.01)]),
      seg(2, 4, "Am", [cand(9, "minor", 0), cand(6, "minor", -0.5)]),
      seg(4, 6, "C", [cand(0, "major", 0), cand(5, "major", 0.01)]),
    ];
    const v1 = applyTheoryReevaluation(segs, A_MINOR, THEORY_WEIGHTS);
    expect(v1[1].chord).toBe("F#m");
    const v2 = applyTheoryReevaluation(segs, A_MINOR, THEORY_WEIGHTS_V2);
    expect(v2[1].chord).toBe("Am");
    expect(v2[1].theoryRationale).toBeUndefined();
  });

  it("柱1+3: 理論の裏付けがあれば負マージンの代替も勝てる（格上げの機構）", () => {
    // 勝者 F# は A minor の文脈で節点不利（キー適合 0、説明可能性の
    // 床のみ）。代替 B は集計で大きく優位（−0.586）だが v2 では
    // emission が 0 になるため、格上げは理論項（キー適合の差＋
    // B→E の二次ドミナント解決）がホームアドバンテージを超えた
    // 場合にだけ起こる。実フィクスチャ（stems-05 の B7）の帰趨は
    // 測定の関門 3b で判定するもので、ここでは機構だけを固定する
    const segs = [
      seg(0, 2, "C", [cand(0, "major", 0), cand(9, "minor", 0.02)]),
      seg(2, 4, "F#", [
        cand(6, "major", 0),
        cand(11, "major", -0.586),
        cand(3, "minor", -0.564),
      ]),
      seg(4, 6, "E", [cand(4, "major", 0), cand(9, "minor", 0.03)]),
      seg(6, 8, "Am", [cand(9, "minor", 0), cand(0, "major", 0.02)]),
    ];
    const v2 = applyTheoryReevaluation(segs, A_MINOR, THEORY_WEIGHTS_V2);
    expect(v2[1].chord).toBe("B");
    expect(v2[1].theoryRationale).toBeDefined();
    expect(v2[1].theoryRationale!.acousticMargin).toBeCloseTo(-0.586);
  });

  it("柱3: 解決先の主和音は集計の反対から守られる（Q3-Am 型、v1 では破壊された形）", () => {
    // stems-05 の Q3-Am 破壊の再現: E の直後の Am が Em（−0.197）
    // と G（−0.359）に集計で負けていた。v1 は emission の正の
    // 支持だけで Em に反転するが、v2 では V→I の遷移評価と
    // ホームアドバンテージが現ラベルを守る
    const segs = [
      seg(0, 2, "C", [cand(0, "major", 0), cand(9, "minor", 0.02)]),
      seg(2, 4, "B", [cand(11, "major", 0), cand(9, "minor", 0.02)]),
      seg(4, 6, "E", [cand(4, "major", 0), cand(9, "minor", 0.02)]),
      seg(6, 8, "Am", [
        cand(9, "minor", 0),
        cand(4, "minor", -0.197),
        cand(7, "major", -0.359),
      ]),
      seg(8, 10, "C", [cand(0, "major", 0), cand(9, "minor", 0.02)]),
    ];
    const v1 = applyTheoryReevaluation(segs, A_MINOR, THEORY_WEIGHTS);
    // 初回の失敗形: 集計の支持が大きい G（−0.359）に反転する
    // （実 stems-05 では窓内の別セグメントが Em に反転した）
    expect(v1[3].chord).toBe("G");
    const v2 = applyTheoryReevaluation(segs, A_MINOR, THEORY_WEIGHTS_V2);
    expect(v2[3].chord).toBe("Am");
    expect(v2[3].theoryRationale).toBeUndefined();
  });

  it("柱2 キーゲート: 信頼度の低い局所キー窓ではキー項が沈黙する", () => {
    // 機構の単体確認のため、遷移とホームを外した派生重みで
    // キー項だけが駆動する状況を作る: 勝者 F#m は C major の
    // キーに合わず、代替 Dm は完全に合う。窓の margin が小さい
    // （曖昧）場合はゲートで沈黙し、大きい場合は発言する
    const weights: TheoryWeights = {
      ...THEORY_WEIGHTS_V2,
      transition: 0,
      homeAdvantage: 0,
      key: 0.05,
      diatonic: 0,
      swingCap: 0.05,
    };
    const mkSegs = () => [
      seg(0, 4, "F#m", [cand(6, "minor", 0), cand(2, "minor", -0.02)]),
    ];
    const mkProfile = (margin: number, correlation: number): TheoryProfile => ({
      keyRoot: 0,
      keyMode: "major",
      localKeys: [
        {
          start: 0,
          end: 4,
          root: 0,
          mode: "major",
          correlation,
          margin,
          runnerUpRoot: 9,
          runnerUpMode: "minor",
        },
      ],
    });
    // 曖昧な窓（margin 0.01 < 0.08）: ゲートで沈黙 → 反転しない
    const silent = applyTheoryReevaluation(mkSegs(), mkProfile(0.01, 0.9), weights);
    expect(silent[0].chord).toBe("F#m");
    // 確からしい窓（margin 0.2, correlation 0.9）: キー項が発言 → 反転する
    const speaks = applyTheoryReevaluation(mkSegs(), mkProfile(0.2, 0.9), weights);
    expect(speaks[0].chord).toBe("Dm");
    expect(speaks[0].theoryRationale!.key).toBeGreaterThan(0);
    // correlation が低い窓も沈黙する
    const lowCorr = applyTheoryReevaluation(mkSegs(), mkProfile(0.2, 0.5), weights);
    expect(lowCorr[0].chord).toBe("F#m");
  });

  it("v2 の構成: floored 前提・ゲート閾値・ホーム = キー適合の最小量子", () => {
    expect(THEORY_WEIGHTS_V2.emissionFloorAtZero).toBe(true);
    expect(THEORY_WEIGHTS_V2.keyGate).toEqual({ margin: 0.08, correlation: 0.74 });
    expect(THEORY_WEIGHTS_V2.homeAdvantage).toBeCloseTo(THEORY_WEIGHTS_V2.key / 3);
    // 軸の重みと上限は v1 と同一（変更点は意味論だけ）
    expect(THEORY_WEIGHTS_V2.key).toBe(THEORY_WEIGHTS.key);
    expect(THEORY_WEIGHTS_V2.diatonic).toBe(THEORY_WEIGHTS.diatonic);
    expect(THEORY_WEIGHTS_V2.transition).toBe(THEORY_WEIGHTS.transition);
    expect(THEORY_WEIGHTS_V2.swingCap).toBe(THEORY_WEIGHTS.swingCap);
  });
});

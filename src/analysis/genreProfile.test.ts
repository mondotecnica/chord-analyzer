import { describe, expect, it } from "vitest";
import type { ChordSegment, GenreFeatures } from "../types";
import { judgeExtension, type SegmentEvidence } from "./extensionDetection";
import {
  estimateGenreProfile,
  extractHarmonyFeatures,
  extractMelodyFeatures,
  extractRhythmFromOnset,
  extractTimbreFeatures,
  genreExtensionFactors,
  parseSegments,
  scoreGenreFeatures,
} from "./genreProfile";

/**
 * Phase 3 後半: 様式プロファイルモジュールの単体テスト。
 * チャンネル別の特徴量計算、傾向スコアリングの向き、消費部係数の
 * 範囲と、第2段（judgeExtension）への効き方（係数だけがゲートを
 * 動かすこと）を固定する。
 */

const FD = 0.1;

function framesWithShares(
  segmentsShares: Float32Array[],
  framesPerSeg: number,
): { frames: Float32Array[]; energies: Float32Array } {
  const frames: Float32Array[] = [];
  for (const s of segmentsShares) {
    for (let i = 0; i < framesPerSeg; i++) frames.push(new Float32Array(s));
  }
  return { frames, energies: new Float32Array(frames.length).fill(1) };
}

function sharesOf(entries: [number, number][]): Float32Array {
  const v = new Float32Array(12);
  for (const [pc, x] of entries) v[pc] = x;
  return v;
}

function seg(id: number, start: number, end: number, chord: string): ChordSegment {
  return { id, start, end, chord, confidence: 1 };
}

const emptyChannels = {
  rhythm: { onsetDensity: null, pulseRegularity: null },
  melody: { scaleConformance: null, chordToneRatio: null, activityShare: null },
  timbre: { bassShare: null, vocalShare: null, drumsShare: null, otherShare: null },
};

function featuresWith(
  harmony: Partial<GenreFeatures["harmony"]>,
  changesPerMinute = 20,
): GenreFeatures {
  return {
    harmony: {
      maj7Presence: null,
      dom7Presence: null,
      m7Presence: null,
      diatonicShare: 0.9,
      secondaryDominantShare: 0.02,
      fifthDescentShare: 0.3,
      minorShare: 0.25,
      slashShare: 0.08,
      flatVIIShare: 0.02,
      vocabSize: 8,
      ...harmony,
    },
    rhythm: { changesPerMinute, ...emptyChannels.rhythm },
    melody: { ...emptyChannels.melody },
    timbre: { ...emptyChannels.timbre },
  };
}

describe("extractHarmonyFeatures（和声チャンネル）", () => {
  it("プレゼンス・ダイアトニック・5度下行・二次ドミナントを計算する", () => {
    // C – D – G – C（各2秒）。D は C major では V/V（二次ドミナント形）
    const cShares = sharesOf([[0, 0.4], [4, 0.3], [7, 0.3]]);
    const dShares = sharesOf([[2, 0.4], [6, 0.3], [9, 0.3]]);
    // G 区間では長7度音 F# に 0.12 のシェアを持たせる
    const gShares = sharesOf([[7, 0.36], [11, 0.28], [2, 0.24], [6, 0.12]]);
    const { frames, energies } = framesWithShares(
      [cShares, dShares, gShares, cShares],
      20,
    );
    const segments = [
      seg(0, 0, 2, "C"),
      seg(1, 2, 4, "D"),
      seg(2, 4, 6, "G"),
      seg(3, 6, 8, "C"),
    ];
    const { harmony: f, changesPerMinute } = extractHarmonyFeatures(
      segments, parseSegments(segments), frames, energies, FD, 0, "major", 8,
    );
    // maj7 プレゼンス: C 区間は B=0、D 区間は C#=0、G 区間は F#=0.12
    expect(f.maj7Presence).toBeCloseTo((0 + 0 + 0.12 + 0) / 4, 5);
    // 短調コードが無いので m7 プレゼンスは測れない
    expect(f.m7Presence).toBeNull();
    // D だけ plausibility < 1（0.636）、残りは 1.0
    expect(f.diatonicShare).toBeCloseTo((1 + 0.636 + 1 + 1) / 4, 2);
    // D → G の5度下行解決で D の時間（全体の 1/4）が二次ドミナント
    expect(f.secondaryDominantShare).toBeCloseTo(0.25, 5);
    // 遷移 C→D(+2) / D→G(+5) / G→C(+5) のうち 2/3 が5度下行
    expect(f.fifthDescentShare).toBeCloseTo(2 / 3, 5);
    expect(f.vocabSize).toBe(3);
    expect(f.minorShare).toBe(0);
    // ランは4つ、8秒 → 30/分
    expect(changesPerMinute).toBeCloseTo(30, 5);
  });

  it("♭VII の時間割合とベース違い（分数）割合を計算する", () => {
    const gShares = sharesOf([[7, 0.4], [11, 0.3], [2, 0.3]]);
    const fShares = sharesOf([[5, 0.4], [9, 0.3], [0, 0.3]]);
    const { frames, energies } = framesWithShares([gShares, fShares], 20);
    const segments = [
      { ...seg(0, 0, 2, "G"), bassPc: 7 },
      { ...seg(1, 2, 4, "F"), bassPc: 0 }, // F/C — ベース ≠ ルート
    ];
    const { harmony: f } = extractHarmonyFeatures(
      segments, parseSegments(segments), frames, energies, FD, 7, "major", 4,
    );
    expect(f.flatVIIShare).toBeCloseTo(0.5, 5);
    expect(f.slashShare).toBeCloseTo(0.5, 5);
  });

  it("短調キーでは ♭VII を測らない（VII はダイアトニック）", () => {
    const aShares = sharesOf([[9, 0.4], [0, 0.3], [4, 0.3]]);
    const gShares = sharesOf([[7, 0.4], [11, 0.3], [2, 0.3]]);
    const { frames, energies } = framesWithShares([aShares, gShares], 20);
    const segments = [seg(0, 0, 2, "Am"), seg(1, 2, 4, "G")];
    const { harmony: f } = extractHarmonyFeatures(
      segments, parseSegments(segments), frames, energies, FD, 9, "minor", 4,
    );
    expect(f.flatVIIShare).toBeNull();
  });
});

describe("extractRhythmFromOnset（リズムチャンネル）", () => {
  it("周期的なオンセットから密度と規則性を測る", () => {
    const fd = 0.05;
    const env = new Float32Array(200); // 10秒
    for (let i = 0; i < env.length; i++) env[i] = i % 10 === 0 ? 1.0 : 0.0;
    const r = extractRhythmFromOnset(env, fd, 10);
    // 先頭フレームはピーク判定の対象外なので 19 ピーク / 10 秒
    expect(r.onsetDensity).toBeCloseTo(1.9, 1);
    expect(r.pulseRegularity).not.toBeNull();
    expect(r.pulseRegularity!).toBeGreaterThan(0.5);
  });

  it("平坦な包絡では規則性は測れない（null）", () => {
    const env = new Float32Array(200).fill(0.5);
    const r = extractRhythmFromOnset(env, 0.05, 10);
    expect(r.onsetDensity).toBe(0);
    expect(r.pulseRegularity).toBeNull();
  });
});

describe("extractMelodyFeatures（メロディチャンネル）", () => {
  it("スケール適合度とコードトーン比率を測る", () => {
    const frames: Float32Array[] = [];
    for (let i = 0; i < 20; i++) {
      frames.push(sharesOf([[0, 0.5], [4, 0.3], [7, 0.2]])); // C E G のみ
    }
    const melody = {
      frames,
      energies: new Float32Array(20).fill(1),
      frameDuration: FD,
    };
    const segments = [seg(0, 0, 2, "C")];
    const f = extractMelodyFeatures(
      segments, parseSegments(segments), melody, 0, "major",
    );
    expect(f.scaleConformance).toBeCloseTo(1, 5);
    expect(f.chordToneRatio).toBeCloseTo(1, 5);
    expect(f.activityShare).toBeCloseTo(1, 5);
  });

  it("無音のボーカルでは全て null（測れないものを測ったことにしない）", () => {
    const frames = [new Float32Array(12), new Float32Array(12)];
    const melody = {
      frames,
      energies: new Float32Array(2).fill(0),
      frameDuration: FD,
    };
    const segments = [seg(0, 0, 2, "C")];
    const f = extractMelodyFeatures(
      segments, parseSegments(segments), melody, 0, "major",
    );
    expect(f.scaleConformance).toBeNull();
    expect(f.chordToneRatio).toBeNull();
    expect(f.activityShare).toBeNull();
  });
});

describe("extractTimbreFeatures（音色チャンネル）", () => {
  it("4ステムの RMS シェアを出す。揃わなければ全て null", () => {
    const f = extractTimbreFeatures({ vocals: 1, drums: 2, bass: 1, other: 2 });
    expect(f.vocalShare).toBeCloseTo(1 / 6, 5);
    expect(f.drumsShare).toBeCloseTo(2 / 6, 5);
    expect(f.bassShare).toBeCloseTo(1 / 6, 5);
    expect(f.otherShare).toBeCloseTo(2 / 6, 5);
    const none = extractTimbreFeatures(undefined);
    expect(none.bassShare).toBeNull();
    expect(none.vocalShare).toBeNull();
  });
});

describe("scoreGenreFeatures（混合比率）", () => {
  it("ジャズ的な特徴量では jazz の比率が最大になり、分布は合計1で降順", () => {
    const scores = scoreGenreFeatures(
      featuresWith(
        {
          maj7Presence: 0.09,
          dom7Presence: 0.09,
          m7Presence: 0.12,
          diatonicShare: 0.85,
          secondaryDominantShare: 0.12,
          fifthDescentShare: 0.5,
          vocabSize: 14,
        },
        30,
      ),
    );
    expect(scores[0].style).toBe("jazz");
    const sum = scores.reduce((a, s) => a + s.score, 0);
    expect(sum).toBeCloseTo(1, 6);
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i - 1].score).toBeGreaterThanOrEqual(scores[i].score);
    }
  });

  it("ブルース的な特徴量（dom7 強・maj7 弱）では blues の比率が最大", () => {
    const scores = scoreGenreFeatures(
      featuresWith({
        maj7Presence: 0.015,
        dom7Presence: 0.14,
        m7Presence: 0.06,
        diatonicShare: 0.95,
        secondaryDominantShare: 0.0,
        vocabSize: 5,
      }),
    );
    expect(scores[0].style).toBe("blues");
  });

  it("ロック的な特徴量（♭VII 強・7th 弱）では rock が pop より上", () => {
    const scores = scoreGenreFeatures(
      featuresWith({
        maj7Presence: 0.02,
        dom7Presence: 0.03,
        m7Presence: 0.03,
        diatonicShare: 0.88,
        flatVIIShare: 0.22,
        vocabSize: 6,
      }),
    );
    const rock = scores.find((s) => s.style === "rock")!;
    const pop = scores.find((s) => s.style === "pop")!;
    expect(rock.score).toBeGreaterThan(pop.score);
  });
});

describe("estimateGenreProfile のチャンネル記録", () => {
  it("追加チャンネルが無い入力では melody/timbre が欠落として記録される", () => {
    const cShares = sharesOf([[0, 0.4], [4, 0.3], [7, 0.3]]);
    const { frames, energies } = framesWithShares([cShares], 20);
    const segments = [seg(0, 0, 2, "C")];
    const p = estimateGenreProfile(segments, frames, energies, FD, 0, "major", 2);
    expect(p.channels).toEqual({
      harmony: true,
      rhythm: false,
      melody: false,
      timbre: false,
    });
    const env = new Float32Array(40);
    for (let i = 0; i < env.length; i++) env[i] = i % 5 === 0 ? 1 : 0;
    const p2 = estimateGenreProfile(segments, frames, energies, FD, 0, "major", 2, {
      onsetEnvelope: env,
      onsetFrameDuration: FD,
    });
    expect(p2.channels.rhythm).toBe(true);
    expect(p2.channels.melody).toBe(false);
  });
});

describe("genreExtensionFactors（消費部）", () => {
  it("係数は [0.88, 1.11] の範囲に収まり、jazz は緩く rock は厳しい", () => {
    const empty = estimateGenreProfile([], [], new Float32Array(0), FD, 0, "major", 0);
    const mk = (style: string) => ({
      ...empty,
      scores: [{ style: style as never, score: 1 }],
      top: style as never,
      confidence: 1,
      margin: 1,
    });
    const jazz = genreExtensionFactors(mk("jazz"));
    const rock = genreExtensionFactors(mk("rock"));
    const blues = genreExtensionFactors(mk("blues"));
    for (const f of [jazz, rock, blues]) {
      for (const v of Object.values(f)) {
        expect(v).toBeGreaterThanOrEqual(0.88);
        expect(v).toBeLessThanOrEqual(1.11);
      }
    }
    expect(jazz.maj7).toBeCloseTo(0.88, 5);
    expect(rock.maj7).toBeGreaterThan(1.05);
    // ブルースは dom7 だけ緩い（I の dom7 が常套）
    expect(blues["7"]).toBeCloseTo(0.88, 5);
    expect(blues.maj7).toBeGreaterThan(1.05);
  });

  it("混合比率で重み付けされる（単一ラベルで切り替わらない）", () => {
    const empty = estimateGenreProfile([], [], new Float32Array(0), FD, 0, "major", 0);
    const mixed = {
      ...empty,
      scores: [
        { style: "jazz" as never, score: 0.5 },
        { style: "rock" as never, score: 0.5 },
      ],
      top: "jazz" as never,
      confidence: 0.5,
      margin: 0,
    };
    const f = genreExtensionFactors(mixed);
    // maj7 親和度 = 0.5×1.0 + 0.5×0.1 = 0.55 → factor = 1.11 − 0.23×0.55
    expect(f.maj7).toBeCloseTo(1.11 - 0.23 * 0.55, 5);
  });

  it("judgeExtension: 係数だけが境界上の maj7 のゲートを動かす", () => {
    // C コード、長7度 B のシェア 0.105（床 0.10 のすぐ上）。
    // 適合度改善は正（maj7 テンプレートが勝つ）になる配分にしてある
    const shares = new Float32Array(12);
    shares[0] = 0.25; // C
    shares[4] = 0.24; // E
    shares[7] = 0.2; // G
    shares[11] = 0.105; // B
    for (let p = 0; p < 12; p++) {
      if (shares[p] === 0) shares[p] = 0.0293;
    }
    const persistence = new Float32Array(12).fill(0.9);
    const evidence: SegmentEvidence = { shares, persistence };
    // D major キー文脈（CM7 はダイアトニック緩和を受けない）
    const baseCtx = { keyRoot: 2, keyMode: "major" as const };

    const plain = judgeExtension("C", 0, evidence, { ...baseCtx });
    expect(plain.extension).toBe("maj7");

    const neutral = judgeExtension("C", 0, evidence, {
      ...baseCtx,
      genreFactors: { maj7: 1.0, "7": 1.0, m7: 1.0 },
    });
    expect(neutral.extension).toBe("maj7");

    const strict = judgeExtension("C", 0, evidence, {
      ...baseCtx,
      genreFactors: { maj7: 1.11, "7": 1.0, m7: 1.0 },
    });
    expect(strict.extension).toBeUndefined();

    const loose = judgeExtension("C", 0, evidence, {
      ...baseCtx,
      genreFactors: { maj7: 0.88, "7": 1.0, m7: 1.0 },
    });
    expect(loose.extension).toBe("maj7");
  });
});

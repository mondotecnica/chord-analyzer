import { describe, expect, it } from "vitest";
import {
  estimateMeter,
  rankMeterCandidates,
  type MeterInput,
} from "./meterEstimate";

/**
 * Phase 3 §5: 拍子・小節推定モジュールの単体テスト。
 * 包絡は合成パルス列で作る（実音源での検証は
 * scripts/measurePhaseMeter.ts と PHASE3_METER_RESULTS.md）。
 */

const FD = 0.01; // テスト用のフレーム間隔（秒）

/**
 * 拍パルス列＋小節アクセントを持つオンセット包絡を作る。
 * 実音源のフラックスに寄せて、減衰する尾と低い背景ノイズを付け、
 * 自己相関が実音源のレンジ（ピーク 0.3 前後）に収まるようにする
 * （純粋なインパルス列だと全候補の自己相関が飽和してしまう）。
 */
function pulseEnvelope(
  durationSec: number,
  beatSec: number,
  beatsPerBar: number,
): Float32Array {
  const n = Math.floor(durationSec / FD);
  const env = new Float32Array(n);
  let seed = 987654321;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (let i = 0; i < n; i++) env[i] = 0.03 * rand();
  let beatIdx = 0;
  for (let t = beatSec * 0.5; t < durationSec; t += beatSec, beatIdx++) {
    const amp = beatIdx % beatsPerBar === 0 ? 1.0 : 0.35;
    const center = Math.round(t / FD);
    for (let k = 0; k < 20 && center + k < n; k++) {
      env[center + k] += amp * Math.exp(-k / 5) * (k === 0 ? 1 : 0.8);
    }
  }
  return env;
}

/** 小節境界にセグメント境界を持つセグメント列 */
function barSegments(durationSec: number, barSec: number, offset = 0) {
  const segs: { start: number; end: number }[] = [];
  let t = 0;
  let next = offset > 0 ? offset : barSec;
  while (t < durationSec) {
    const end = Math.min(durationSec, next);
    segs.push({ start: t, end });
    t = end;
    next += barSec;
  }
  return segs;
}

function input(partial: Partial<MeterInput>): MeterInput {
  return {
    onsetEnvelope: new Float32Array(4000),
    frameDuration: FD,
    segments: [],
    detectedBpm: 120,
    durationSec: 40,
    onsetSource: "mixture",
    ...partial,
  };
}

describe("拍子・小節推定（合成パルス列）", () => {
  it("4/4・120 BPM を (スケール1, 4拍子) と確定する", () => {
    const est = estimateMeter(
      input({
        onsetEnvelope: pulseEnvelope(40, 0.5, 4),
        segments: barSegments(40, 2.0),
        detectedBpm: 120,
      }),
    );
    expect(est).not.toBeNull();
    expect(est!.beatsPerBar).toBe(4);
    expect(est!.notation).toBe("4/4");
    expect(est!.tempoScale).toBe(1);
    expect(est!.tempoBpm).toBe(120);
    expect(est!.barSec).toBeCloseTo(2.0, 5);
  });

  it("倍取りグリッド (スケール1/2, 4拍子) が真の小節に勝たない", () => {
    const ranked = rankMeterCandidates(
      input({
        onsetEnvelope: pulseEnvelope(40, 0.5, 4),
        segments: barSegments(40, 2.0),
        detectedBpm: 120,
      }),
    );
    const half = ranked.find((c) => c.scale === 0.5 && c.beatsPerBar === 4)!;
    const truth = ranked.find((c) => c.scale === 1 && c.beatsPerBar === 4)!;
    expect(truth.score).toBeGreaterThan(half.score);
    // 小節の整数倍グリッドでは中間線に落ちる境界が減点される
    expect(truth.boundary).toBeGreaterThan(half.boundary);
  });

  it("SUNO_05 型の衝突: (108, 3拍子) が (72, 2拍子) に勝つ", () => {
    // 拍 0.556 秒（108）、小節 1.667 秒。72 の拍（0.833 秒）は実在しない
    const est = estimateMeter(
      input({
        onsetEnvelope: pulseEnvelope(60, 1 / 1.8, 3),
        segments: barSegments(60, 5 / 3),
        detectedBpm: 108,
        durationSec: 60,
      }),
    );
    expect(est).not.toBeNull();
    expect(est!.beatsPerBar).toBe(3);
    expect(est!.notation).toBe("3/4");
    expect(est!.tempoScale).toBe(1);
    expect(est!.tempoBpm).toBe(108);
    expect(est!.barSec).toBeCloseTo(5 / 3, 2);
  });

  it("3:2 取り違えを仲裁する: 検出 92 → 真の拍 137 系 (スケール 3/2, 4拍子)", () => {
    const trueBeat = 60 / 137;
    const est = estimateMeter(
      input({
        onsetEnvelope: pulseEnvelope(60, trueBeat, 4),
        segments: barSegments(60, trueBeat * 4),
        detectedBpm: 92,
        durationSec: 60,
      }),
    );
    expect(est).not.toBeNull();
    expect(est!.tempoScale).toBe(1.5);
    expect(est!.beatsPerBar).toBe(4);
    expect(est!.tempoBpm).toBe(138);
  });

  it("倍取りを仲裁する: 検出 129 → 半分 (スケール 1/2, 4拍子)", () => {
    const trueBeat = 60 / 64.5;
    const est = estimateMeter(
      input({
        onsetEnvelope: pulseEnvelope(60, trueBeat, 4),
        segments: barSegments(60, trueBeat * 4),
        detectedBpm: 129,
        durationSec: 60,
      }),
    );
    expect(est).not.toBeNull();
    expect(est!.tempoScale).toBe(0.5);
    expect(est!.beatsPerBar).toBe(4);
    expect(est!.tempoBpm).toBe(65);
  });

  it("ノイズ包絡では判定保留にする（誤った自信を持たない）", () => {
    // 決定的な疑似乱数（LCG）で周期性の無い包絡を作る
    let seed = 123456789;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const env = new Float32Array(6000);
    for (let i = 0; i < env.length; i++) env[i] = rand();
    const est = estimateMeter(
      input({
        onsetEnvelope: env,
        segments: barSegments(60, 2.4),
        detectedBpm: 100,
        durationSec: 60,
      }),
    );
    expect(est).not.toBeNull();
    expect(est!.beatsPerBar).toBeNull();
    expect(est!.notation).toBeNull();
    expect(est!.tempoScale).toBe(1);
    expect(est!.tempoBpm).toBe(100);
  });

  it("検出 BPM が無い場合は null を返す", () => {
    expect(estimateMeter(input({ detectedBpm: null }))).toBeNull();
  });

  it("境界が少なくても信号証拠だけで確定できる", () => {
    const est = estimateMeter(
      input({
        onsetEnvelope: pulseEnvelope(40, 0.5, 4),
        segments: [{ start: 0, end: 40 }],
        detectedBpm: 120,
      }),
    );
    expect(est).not.toBeNull();
    expect(est!.beatsPerBar).toBe(4);
    expect(est!.evidence.boundary).toBe(0);
  });
});

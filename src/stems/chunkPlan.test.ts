import { describe, expect, it } from "vitest";
import {
  assembleSegments,
  planModelSegments,
  planSegments,
  planSongChunks,
  segmentWeightAt,
} from "./chunkPlan";
import { MODEL_SEGMENT_SAMPLES } from "./config";

describe("planSegments", () => {
  it("重なりを持って末尾まで覆う", () => {
    const plan = planSegments(100, 30, 10);
    expect(plan.map((w) => w.start)).toEqual([0, 20, 40, 60, 80]);
    expect(plan.every((w) => w.length === 30)).toBe(true);
    expect(plan.map((w) => w.index)).toEqual([0, 1, 2, 3, 4]);
  });

  it("信号が 1 窓以下の場合は窓 1 つ", () => {
    expect(planSegments(30, 30, 10)).toHaveLength(1);
    expect(planSegments(5, 30, 10)).toHaveLength(1);
  });

  it("空の信号は空の計画", () => {
    expect(planSegments(0, 30, 10)).toEqual([]);
  });

  it("不正な引数は例外", () => {
    expect(() => planSegments(-1, 30, 10)).toThrow();
    expect(() => planSegments(100, 0, 0)).toThrow();
    expect(() => planSegments(100, 30, 30)).toThrow();
    expect(() => planSegments(100, 30, -1)).toThrow();
  });

  it("planSongChunks は 30 秒 / 2.5 秒の初期値を使う", () => {
    const plan = planSongChunks(44100 * 65, 44100);
    expect(plan).toHaveLength(3);
    expect(plan[0].length).toBe(44100 * 30);
    expect(plan[1].start - plan[0].start).toBe(44100 * 30 - 44100 * 2.5);
  });

  it("planModelSegments はモデル入力長と 25% 重なりを使う", () => {
    const total = MODEL_SEGMENT_SAMPLES * 2;
    const plan = planModelSegments(total);
    expect(plan[0].length).toBe(MODEL_SEGMENT_SAMPLES);
    const stride = plan[1].start - plan[0].start;
    expect(stride).toBe(
      MODEL_SEGMENT_SAMPLES - Math.floor(MODEL_SEGMENT_SAMPLES * 0.25),
    );
  });
});

describe("segmentWeightAt", () => {
  const both = { fadeIn: true, fadeOut: true };

  it("フェード区間では線形、中央では 1", () => {
    expect(segmentWeightAt(0, 100, 10, both)).toBe(0);
    expect(segmentWeightAt(5, 100, 10, both)).toBeCloseTo(0.5);
    expect(segmentWeightAt(50, 100, 10, both)).toBe(1);
    expect(segmentWeightAt(95, 100, 10, both)).toBeCloseTo(0.5);
  });

  it("信号端に接する側はフェードしない", () => {
    expect(segmentWeightAt(0, 100, 10, { fadeIn: false, fadeOut: true })).toBe(1);
    expect(segmentWeightAt(99, 100, 10, { fadeIn: true, fadeOut: false })).toBe(1);
  });

  it("フェード長 0 では常に 1", () => {
    expect(segmentWeightAt(0, 100, 0, both)).toBe(1);
  });
});

describe("assembleSegments", () => {
  /** 決定的なテスト信号 */
  function signal(n: number): Float32Array {
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = Math.sin(i * 0.05) + (i % 7) * 0.01;
    return out;
  }

  function slicesOf(
    sig: Float32Array,
    plan: ReturnType<typeof planSegments>,
  ): { start: number; channels: Float32Array[] }[] {
    return plan.map((w) => {
      const ch = new Float32Array(w.length);
      for (let i = 0; i < w.length && w.start + i < sig.length; i++) {
        ch[i] = sig[w.start + i];
      }
      return { start: w.start, channels: [ch] };
    });
  }

  it("窓出力が元信号のスライスなら、合成結果は元信号に一致する", () => {
    const sig = signal(1000);
    const plan = planSegments(1000, 300, 100);
    const assembled = assembleSegments(1000, slicesOf(sig, plan), 100);
    expect(assembled).toHaveLength(1);
    let maxErr = 0;
    for (let i = 0; i < 1000; i++) {
      maxErr = Math.max(maxErr, Math.abs(assembled[0][i] - sig[i]));
    }
    expect(maxErr).toBeLessThan(1e-5);
  });

  it("単一窓では端も含めて完全一致する", () => {
    const sig = signal(50);
    const assembled = assembleSegments(
      50,
      [{ start: 0, channels: [new Float32Array(sig)] }],
      10,
    );
    expect(Array.from(assembled[0])).toEqual(Array.from(sig));
  });

  it("複数チャンネルを独立に合成する", () => {
    const a = signal(100);
    const b = new Float32Array(100).fill(0.25);
    const assembled = assembleSegments(
      100,
      [{ start: 0, channels: [a, b] }],
      10,
    );
    expect(assembled).toHaveLength(2);
    expect(Array.from(assembled[1])).toEqual(new Array(100).fill(0.25));
  });

  it("出力が無ければ空配列、チャンネル不一致は例外", () => {
    expect(assembleSegments(100, [], 10)).toEqual([]);
    expect(() =>
      assembleSegments(
        100,
        [
          { start: 0, channels: [new Float32Array(10)] },
          { start: 5, channels: [new Float32Array(10), new Float32Array(10)] },
        ],
        2,
      ),
    ).toThrow();
  });
});

import { describe, expect, it } from "vitest";
import {
  buildSeparationCalibration,
  computeSeparationRatio,
  estimateSeparationSeconds,
  formatApproxDuration,
  loadSeparationCalibration,
  parseSeparationCalibration,
  recordSeparationCalibration,
  saveSeparationCalibration,
  serializeSeparationCalibration,
  SEPARATION_CALIBRATION_KEY,
} from "./separationCalibration";
import type { StorageLike } from "./separationMarker";

/** Map ベースの偽 Storage */
class FakeStorage implements StorageLike {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

/** すべての操作が例外を投げる Storage（プライベートモード等の再現） */
const throwingStorage: StorageLike = {
  getItem() {
    throw new Error("denied");
  },
  setItem() {
    throw new Error("denied");
  },
  removeItem() {
    throw new Error("denied");
  },
};

describe("separationCalibration 純関数", () => {
  it("比率は 分離秒数 ÷ 曲の秒数", () => {
    // 実機報告の形: 3分25秒（205秒）の曲に 20分（1200秒）
    expect(computeSeparationRatio(1200, 205)).toBeCloseTo(5.85, 2);
    expect(computeSeparationRatio(60, 60)).toBe(1);
  });

  it("不正な入力では比率を作らない", () => {
    expect(computeSeparationRatio(0, 100)).toBeNull();
    expect(computeSeparationRatio(100, 0)).toBeNull();
    expect(computeSeparationRatio(-1, 100)).toBeNull();
    expect(computeSeparationRatio(Number.NaN, 100)).toBeNull();
    expect(computeSeparationRatio(100, Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("記録を組み立て、直列化して読み戻せる", () => {
    const rec = buildSeparationCalibration(1200, 205, "wasm", 1700000000000);
    expect(rec).not.toBeNull();
    expect(rec?.ratio).toBeCloseTo(5.85, 2);
    expect(rec?.provider).toBe("wasm");
    expect(rec?.updatedAt).toBe(1700000000000);
    expect(parseSeparationCalibration(serializeSeparationCalibration(rec!))).toEqual(rec);
  });

  it("provider が無ければ記録にも含めない", () => {
    const rec = buildSeparationCalibration(60, 60, undefined, 1);
    expect(rec).toEqual({ ratio: 1, updatedAt: 1 });
  });

  it("壊れた文字列は null（記録なし扱い）", () => {
    expect(parseSeparationCalibration(null)).toBeNull();
    expect(parseSeparationCalibration("")).toBeNull();
    expect(parseSeparationCalibration("{not json")).toBeNull();
    expect(parseSeparationCalibration("[]")).toBeNull();
    expect(parseSeparationCalibration('"just a string"')).toBeNull();
    // ratio が無い／不正
    expect(parseSeparationCalibration('{"updatedAt":1}')).toBeNull();
    expect(parseSeparationCalibration('{"ratio":-2,"updatedAt":1}')).toBeNull();
    expect(parseSeparationCalibration('{"ratio":0,"updatedAt":1}')).toBeNull();
    expect(parseSeparationCalibration('{"ratio":1e9,"updatedAt":1}')).toBeNull();
    // updatedAt が無い／不正
    expect(parseSeparationCalibration('{"ratio":2}')).toBeNull();
    expect(parseSeparationCalibration('{"ratio":2,"updatedAt":"x"}')).toBeNull();
    // provider が想定外
    expect(
      parseSeparationCalibration('{"ratio":2,"provider":"cuda","updatedAt":1}'),
    ).toBeNull();
  });

  it("見積もりは 比率 × 曲の秒数", () => {
    const rec = buildSeparationCalibration(1200, 205, "wasm", 1)!;
    expect(estimateSeparationSeconds(rec, 205)).toBeCloseTo(1200, 6);
    expect(estimateSeparationSeconds(rec, 410)).toBeCloseTo(2400, 6);
    expect(estimateSeparationSeconds(null, 205)).toBeNull();
    expect(estimateSeparationSeconds(rec, 0)).toBeNull();
  });

  it("概算フォーマット: 60秒未満は秒、以上は分に丸める", () => {
    expect(formatApproxDuration(45)).toBe("約45秒");
    expect(formatApproxDuration(59.6)).toBe("約60秒");
    expect(formatApproxDuration(60)).toBe("約1分");
    expect(formatApproxDuration(1234)).toBe("約21分");
  });
});

describe("separationCalibration ストレージ", () => {
  it("保存して読み戻せる（キーは専用のものを使う）", () => {
    const storage = new FakeStorage();
    const rec = buildSeparationCalibration(300, 100, "webgpu", 42)!;
    saveSeparationCalibration(rec, storage);
    expect(storage.getItem(SEPARATION_CALIBRATION_KEY)).not.toBeNull();
    expect(loadSeparationCalibration(storage)).toEqual(rec);
  });

  it("記録が無ければ null", () => {
    expect(loadSeparationCalibration(new FakeStorage())).toBeNull();
  });

  it("壊れた保存内容は null として扱う", () => {
    const storage = new FakeStorage();
    storage.setItem(SEPARATION_CALIBRATION_KEY, "{broken");
    expect(loadSeparationCalibration(storage)).toBeNull();
  });

  it("ストレージ例外でも本体を壊さない", () => {
    const rec = buildSeparationCalibration(300, 100, "wasm", 42)!;
    expect(() => saveSeparationCalibration(rec, throwingStorage)).not.toThrow();
    expect(loadSeparationCalibration(throwingStorage)).toBeNull();
    expect(recordSeparationCalibration(300, 100, "wasm", throwingStorage)).toEqual(
      expect.objectContaining({ ratio: 3 }),
    );
  });

  it("record は組み立て＋保存をまとめて行い、不正な実測では何も残さない", () => {
    const storage = new FakeStorage();
    const rec = recordSeparationCalibration(1200, 205, "wasm", storage, 7);
    expect(rec?.updatedAt).toBe(7);
    expect(loadSeparationCalibration(storage)).toEqual(rec);
    expect(recordSeparationCalibration(0, 205, "wasm", storage)).toBeNull();
  });
});

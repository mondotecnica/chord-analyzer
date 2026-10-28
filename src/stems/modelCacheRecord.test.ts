import { describe, expect, it } from "vitest";
import {
  MODEL_CACHED_KEY,
  markModelCached,
  readModelCachedRecord,
  wasModelCachedBefore,
} from "./modelCacheRecord";
import type { StorageLike } from "./separationMarker";

class FakeStorage implements StorageLike {
  readonly data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
}

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

describe("modelCacheRecord（保存できた前歴フラグ）", () => {
  it("記録が無ければ前歴なし", () => {
    const storage = new FakeStorage();
    expect(readModelCachedRecord(storage)).toBeNull();
    expect(wasModelCachedBefore(storage)).toBe(false);
  });

  it("markModelCached で前歴が立ち、時刻が残る", () => {
    const storage = new FakeStorage();
    markModelCached(storage, 123_456);
    expect(readModelCachedRecord(storage)).toEqual({ cachedAt: 123_456 });
    expect(wasModelCachedBefore(storage)).toBe(true);
  });

  it("壊れた記録は前歴なしとして扱う", () => {
    const storage = new FakeStorage();
    storage.data.set(MODEL_CACHED_KEY, "{not json");
    expect(wasModelCachedBefore(storage)).toBe(false);
    storage.data.set(MODEL_CACHED_KEY, JSON.stringify({ cachedAt: "soon" }));
    expect(wasModelCachedBefore(storage)).toBe(false);
  });

  it("ストレージが例外を投げても外へ漏らさない", () => {
    expect(() => markModelCached(throwingStorage)).not.toThrow();
    expect(wasModelCachedBefore(throwingStorage)).toBe(false);
  });

  it("ストレージが無い環境では前歴なし・記録もしない", () => {
    expect(wasModelCachedBefore(null)).toBe(false);
    expect(() => markModelCached(null)).not.toThrow();
  });
});

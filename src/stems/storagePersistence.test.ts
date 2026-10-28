import { describe, expect, it, vi } from "vitest";
import {
  requestPersistentStorage,
  type NavigatorLike,
} from "./storagePersistence";

describe("requestPersistentStorage", () => {
  it("persist が認められれば true、estimate の使用量／上限も読む", async () => {
    const nav: NavigatorLike = {
      storage: {
        persist: vi.fn(async () => true),
        estimate: vi.fn(async () => ({ usage: 1234, quota: 5678 })),
      },
    };
    const info = await requestPersistentStorage(nav);
    expect(info).toEqual({
      persistGranted: true,
      usageBytes: 1234,
      quotaBytes: 5678,
    });
  });

  it("persist が無ければ persisted() で現在の状態を読む", async () => {
    const nav: NavigatorLike = {
      storage: { persisted: vi.fn(async () => false) },
    };
    const info = await requestPersistentStorage(nav);
    expect(info.persistGranted).toBe(false);
    expect(info.usageBytes).toBeNull();
    expect(info.quotaBytes).toBeNull();
  });

  it("storage API が無い環境では全て null（不明）", async () => {
    expect(await requestPersistentStorage({})).toEqual({
      persistGranted: null,
      usageBytes: null,
      quotaBytes: null,
    });
    expect(await requestPersistentStorage(null)).toEqual({
      persistGranted: null,
      usageBytes: null,
      quotaBytes: null,
    });
  });

  it("API が例外を投げても外へ漏らさず null を返す", async () => {
    const nav: NavigatorLike = {
      storage: {
        persist: vi.fn(async () => {
          throw new Error("denied");
        }),
        estimate: vi.fn(async () => {
          throw new Error("denied");
        }),
      },
    };
    const info = await requestPersistentStorage(nav);
    expect(info).toEqual({
      persistGranted: null,
      usageBytes: null,
      quotaBytes: null,
    });
  });
});

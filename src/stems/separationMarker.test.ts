import { describe, expect, it } from "vitest";
import {
  clearSeparationMarker,
  markSeparationStarted,
  readSeparationMarker,
  SEPARATION_MARKER_KEY,
  takeSeparationMarker,
  type StorageLike,
} from "./separationMarker";

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

describe("separationMarker", () => {
  it("開始を記録すると読み戻せる", () => {
    const storage = new FakeStorage();
    markSeparationStarted("song.mp3", storage, 1234567890);
    expect(readSeparationMarker(storage)).toEqual({
      startedAt: 1234567890,
      fileName: "song.mp3",
      mode: "high-accuracy",
    });
  });

  it("マーカーが無ければ null", () => {
    expect(readSeparationMarker(new FakeStorage())).toBeNull();
    expect(takeSeparationMarker(new FakeStorage())).toBeNull();
  });

  it("take は読み取りと同時に消す（起動時通知は一度だけ）", () => {
    const storage = new FakeStorage();
    markSeparationStarted("a.wav", storage, 42);
    const taken = takeSeparationMarker(storage);
    expect(taken?.fileName).toBe("a.wav");
    expect(readSeparationMarker(storage)).toBeNull();
    expect(takeSeparationMarker(storage)).toBeNull();
  });

  it("clear で消える（正常終了・失敗・キャンセルの各経路）", () => {
    const storage = new FakeStorage();
    markSeparationStarted("b.mp3", storage);
    clearSeparationMarker(storage);
    expect(storage.getItem(SEPARATION_MARKER_KEY)).toBeNull();
    expect(readSeparationMarker(storage)).toBeNull();
  });

  it("壊れた JSON や想定外の形はマーカーとして扱わない", () => {
    const storage = new FakeStorage();
    storage.setItem(SEPARATION_MARKER_KEY, "{not json");
    expect(readSeparationMarker(storage)).toBeNull();
    storage.setItem(
      SEPARATION_MARKER_KEY,
      JSON.stringify({ startedAt: "x", fileName: 1, mode: "simple" }),
    );
    expect(readSeparationMarker(storage)).toBeNull();
  });

  it("ストレージが例外を投げても関数は投げない", () => {
    expect(() => markSeparationStarted("c.mp3", throwingStorage)).not.toThrow();
    expect(() => clearSeparationMarker(throwingStorage)).not.toThrow();
    expect(readSeparationMarker(throwingStorage)).toBeNull();
    expect(takeSeparationMarker(throwingStorage)).toBeNull();
  });

  it("ストレージが無い（null 明示）場合は何もしない", () => {
    expect(() => markSeparationStarted("d.mp3", null)).not.toThrow();
    expect(readSeparationMarker(null)).toBeNull();
    expect(takeSeparationMarker(null)).toBeNull();
  });
});

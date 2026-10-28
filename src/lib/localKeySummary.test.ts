import { describe, expect, it } from "vitest";
import type { LocalKeyWindow } from "../types";
import { summarizeLocalKeys } from "./localKeySummary";

/** 窓列を合成する（12 秒窓・4 秒ホップ相当の並び） */
function windows(keys: [number, "major" | "minor"][]): LocalKeyWindow[] {
  return keys.map(([root, mode], i) => ({
    start: i * 4,
    end: i * 4 + 12,
    root,
    mode,
    correlation: 0.8,
    margin: 0.05,
    runnerUpRoot: root,
    runnerUpMode: mode,
  }));
}

describe("summarizeLocalKeys", () => {
  it("未設定・空は null", () => {
    expect(summarizeLocalKeys(undefined)).toBeNull();
    expect(summarizeLocalKeys([])).toBeNull();
  });

  it("単一キーだけなら中心キー＝そのキーで変化点なし", () => {
    const s = summarizeLocalKeys(
      windows([
        [9, "minor"],
        [9, "minor"],
        [9, "minor"],
      ]),
    );
    expect(s).toEqual({ dominantRoot: 9, dominantMode: "minor", changes: [] });
  });

  it("転調（前半 D♭ major → 後半 D major）を変化点として拾う", () => {
    const keys: [number, "major" | "minor"][] = [
      ...Array<[number, "major" | "minor"]>(8).fill([1, "major"]),
      ...Array<[number, "major" | "minor"]>(4).fill([2, "major"]),
    ];
    const s = summarizeLocalKeys(windows(keys))!;
    expect(s.dominantRoot).toBe(1);
    expect(s.dominantMode).toBe("major");
    expect(s.changes).toEqual([{ atSec: 32, root: 2, mode: "major" }]);
  });

  it("1窓だけのフリップは畳まれて変化点にならない", () => {
    const s = summarizeLocalKeys(
      windows([
        [9, "minor"],
        [9, "minor"],
        [0, "major"],
        [9, "minor"],
        [9, "minor"],
      ]),
    )!;
    expect(s.changes).toEqual([]);
  });

  it("末尾の1窓だけのランは変化点にしない", () => {
    const s = summarizeLocalKeys(
      windows([
        [0, "major"],
        [0, "major"],
        [0, "major"],
        [7, "major"],
      ]),
    )!;
    expect(s.changes).toEqual([]);
  });
});

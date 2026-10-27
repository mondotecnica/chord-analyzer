import { describe, expect, it } from "vitest";
import {
  detectEnvironment,
  selectExecutionProviders,
  type NavigatorLike,
  type WindowLike,
} from "./environment";

const desktopNav: NavigatorLike = { gpu: { name: "fake-gpu" }, deviceMemory: 16 };
const desktopWin: WindowLike = {
  innerWidth: 1440,
  matchMedia: () => ({ matches: false }),
};
const phoneNav: NavigatorLike = {};
const phoneWin: WindowLike = {
  innerWidth: 390,
  matchMedia: (q) => ({ matches: q.includes("coarse") }),
};

describe("detectEnvironment", () => {
  it("デスクトップ + WebGPU 環境を検出する", () => {
    const env = detectEnvironment(desktopNav, desktopWin);
    expect(env.hasWebGPU).toBe(true);
    expect(env.hasWasm).toBe(true); // Node でも WebAssembly は存在する
    expect(env.deviceMemoryGB).toBe(16);
    expect(env.recommendDesktop).toBe(false);
    expect(env.canAttemptHighAccuracy).toBe(true);
  });

  it("スマホ相当ではデスクトップ推奨になるが、試行は可能", () => {
    const env = detectEnvironment(phoneNav, phoneWin);
    expect(env.hasWebGPU).toBe(false);
    expect(env.isCoarsePointer).toBe(true);
    expect(env.isSmallScreen).toBe(true);
    expect(env.recommendDesktop).toBe(true);
    // ハードブロックしない方針（MODES.md §3.2）: WASM があれば試行可能
    expect(env.canAttemptHighAccuracy).toBe(env.hasWasm);
  });

  it("navigator / window が無くても例外を投げない", () => {
    const env = detectEnvironment(null, null);
    expect(env.hasWebGPU).toBe(false);
    expect(env.deviceMemoryGB).toBeNull();
    expect(env.isSmallScreen).toBe(false);
  });
});

describe("selectExecutionProviders", () => {
  it("WebGPU 優先、WASM フォールバック", () => {
    expect(selectExecutionProviders({ hasWebGPU: true, hasWasm: true })).toEqual([
      "webgpu",
      "wasm",
    ]);
    expect(selectExecutionProviders({ hasWebGPU: false, hasWasm: true })).toEqual([
      "wasm",
    ]);
    expect(selectExecutionProviders({ hasWebGPU: true, hasWasm: false })).toEqual([
      "webgpu",
    ]);
    expect(selectExecutionProviders({ hasWebGPU: false, hasWasm: false })).toEqual(
      [],
    );
  });
});

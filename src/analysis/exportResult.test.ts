import { describe, expect, it } from "vitest";
import { resultToJson } from "./exportResult";
import type { AnalysisResult } from "../types";

function baseResult(overrides: Partial<AnalysisResult> = {}): AnalysisResult {
  return {
    fileName: "song.mp3",
    duration: 205,
    sampleRate: 44100,
    keyName: "C major",
    keyRoot: 0,
    keyMode: "major",
    bpm: 120,
    segments: [
      { id: 0, start: 0, end: 2, chord: "C", confidence: 0.9 },
    ],
    analyzedInMs: 1234,
    ...overrides,
  };
}

describe("resultToJson のモード記録", () => {
  it("簡易モードでは分離関連のフィールドを出さない", () => {
    const json = JSON.parse(resultToJson(baseResult()));
    expect(json.mode).toBe("simple");
    expect(json).not.toHaveProperty("separationModel");
    expect(json).not.toHaveProperty("stemStrategy");
    expect(json).not.toHaveProperty("separationSeconds");
  });

  it("高精度モードで実測があれば separationSeconds（分離本体のみ）を含む", () => {
    const json = JSON.parse(
      resultToJson(
        baseResult({
          mode: "high-accuracy",
          separationModel: "htdemucs",
          stemStrategy: "s-conditional",
          separationSeconds: 1234.56,
        }),
      ),
    );
    expect(json.mode).toBe("high-accuracy");
    expect(json.separationModel).toBe("htdemucs");
    expect(json.stemStrategy).toBe("s-conditional");
    expect(json.separationSeconds).toBe(1234.6);
  });

  it("高精度モードでも実測が無ければ separationSeconds を含まない", () => {
    const json = JSON.parse(
      resultToJson(
        baseResult({
          mode: "high-accuracy",
          separationModel: "htdemucs",
          stemStrategy: "s-conditional",
        }),
      ),
    );
    expect(json.mode).toBe("high-accuracy");
    expect(json).not.toHaveProperty("separationSeconds");
  });
});

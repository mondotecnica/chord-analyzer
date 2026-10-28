import { describe, expect, it } from "vitest";
import { resultToJson, resultToText } from "./exportResult";
import type { AnalysisResult, LocalKeyWindow } from "../types";

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

  it("簡易モードでは modelFetch を出さない", () => {
    const json = JSON.parse(resultToJson(baseResult()));
    expect(json).not.toHaveProperty("modelFetch");
  });

  it("高精度モードで記録があれば modelFetch（取得元／秒数／保存の成否）を含む", () => {
    const json = JSON.parse(
      resultToJson(
        baseResult({
          mode: "high-accuracy",
          separationModel: "htdemucs",
          stemStrategy: "s-conditional",
          modelFetch: {
            source: "download",
            seconds: 182.34,
            persisted: true,
            storagePersisted: true,
            storageUsageBytes: 180_000_000,
            storageQuotaBytes: 1_000_000_000,
          },
        }),
      ),
    );
    expect(json.modelFetch).toEqual({
      source: "download",
      seconds: 182.3,
      persisted: true,
      storagePersisted: true,
      storageUsageBytes: 180_000_000,
      storageQuotaBytes: 1_000_000_000,
    });
  });

  it("キャッシュ読み込みと保存失敗の記録もそのまま写る", () => {
    const cached = JSON.parse(
      resultToJson(
        baseResult({
          mode: "high-accuracy",
          modelFetch: { source: "cache", seconds: 3.21, persisted: null },
        }),
      ),
    );
    expect(cached.modelFetch).toEqual({
      source: "cache",
      seconds: 3.2,
      persisted: null,
    });
    const lost = JSON.parse(
      resultToJson(
        baseResult({
          mode: "high-accuracy",
          modelFetch: {
            source: "download",
            seconds: 100,
            persisted: false,
            cacheLost: true,
          },
        }),
      ),
    );
    expect(lost.modelFetch).toEqual({
      source: "download",
      seconds: 100,
      persisted: false,
      cacheLost: true,
    });
  });
});

describe("局所キーの書き出し（Phase 3.3 分割採用）", () => {
  const localKeys: LocalKeyWindow[] = [
    ...Array.from({ length: 8 }, (_, i) => ({
      start: i * 4,
      end: i * 4 + 12,
      root: 1,
      mode: "major" as const,
      correlation: 0.85,
      margin: 0.1,
      runnerUpRoot: 10,
      runnerUpMode: "minor" as const,
    })),
    ...Array.from({ length: 4 }, (_, i) => ({
      start: (8 + i) * 4,
      end: (8 + i) * 4 + 12,
      root: 2,
      mode: "major" as const,
      correlation: 0.9,
      margin: 0.12,
      runnerUpRoot: 11,
      runnerUpMode: "minor" as const,
    })),
  ];

  it("JSON には localKeys（窓列）が含まれる", () => {
    const json = JSON.parse(resultToJson(baseResult({ localKeys })));
    expect(json.localKeys).toHaveLength(12);
    expect(json.localKeys[0].key).toBe("C# major");
    expect(json.localKeys[0].runnerUpKey).toBe("A# minor");
  });

  it("JSON は記録が無ければ localKeys を含まない（後方互換）", () => {
    const json = JSON.parse(resultToJson(baseResult()));
    expect(json).not.toHaveProperty("localKeys");
  });

  it("テキストには局所キーの要約行が1行入る", () => {
    const text = resultToText(baseResult({ localKeys }));
    const lines = text.split("\n").filter((l) => l.includes("局所キー"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("C# major が中心");
    expect(lines[0]).toContain("D major");
  });

  it("テキストは記録が無ければ局所キー行を出さない", () => {
    const text = resultToText(baseResult());
    expect(text).not.toContain("局所キー");
  });
});

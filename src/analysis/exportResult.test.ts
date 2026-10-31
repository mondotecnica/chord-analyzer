import { describe, expect, it } from "vitest";
import { resultToJson, resultToText } from "./exportResult";
import type { AnalysisResult, ChordSegment, LocalKeyWindow } from "../types";

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

describe("Phase 3.2: 層フィールドの書き出し", () => {
  it("JSON に upperChord / upperExtension / addTones が相加的に含まれる", () => {
    const json = JSON.parse(
      resultToJson(
        baseResult({
          segments: [
            {
              id: 0,
              start: 0,
              end: 2,
              chord: "C#m",
              confidence: 0.9,
              bassPc: 1,
              upperChord: "Am",
              addTones: ["add9"],
            },
          ],
        }),
      ),
    );
    expect(json.segments[0].upperChord).toBe("Am");
    expect(json.segments[0].addTones).toEqual(["add9"]);
    expect(json.segments[0]).not.toHaveProperty("upperExtension");
  });

  it("層フィールドの無いセグメントの JSON には現れない", () => {
    const json = JSON.parse(resultToJson(baseResult()));
    expect(json.segments[0]).not.toHaveProperty("upperChord");
    expect(json.segments[0]).not.toHaveProperty("upperExtension");
    expect(json.segments[0]).not.toHaveProperty("addTones");
  });

  it("テキスト書き出しは層表示（Am(add9)/C#）になる", () => {
    const text = resultToText(
      baseResult({
        segments: [
          {
            id: 0,
            start: 0,
            end: 2,
            chord: "C#m",
            confidence: 0.9,
            bassPc: 1,
            upperChord: "Am",
            addTones: ["add9"],
          },
        ],
      }),
    );
    expect(text).toContain("Am(add9)/C#");
  });
});

describe("拍子・小節推定の書き出し（Phase 3 §5）", () => {
  const meterEstimate: AnalysisResult["meterEstimate"] = {
    beatsPerBar: 3,
    notation: "3/4",
    barPhaseSec: 0.1234,
    barSec: 1.6667,
    tempoBpm: 108,
    detectedBpm: 108,
    tempoScale: 1,
    score: 0.8123,
    margin: 0.1234,
    onsetSource: "drums",
    evidence: { pulse: 0.27, barAutocorr: 0.11, boundary: 0.5, boundaryAutocorr: 0.4 },
    runnerUp: { beatsPerBar: 6, tempoBpm: 108, score: 0.6889 },
  };

  it("JSON には meterEstimate（拍子・位相・仲裁の内訳）が含まれる", () => {
    const json = JSON.parse(resultToJson(baseResult({ meterEstimate })));
    expect(json.meterEstimate.notation).toBe("3/4");
    expect(json.meterEstimate.beatsPerBar).toBe(3);
    expect(json.meterEstimate.barPhaseSec).toBe(0.123);
    expect(json.meterEstimate.barSec).toBe(1.667);
    expect(json.meterEstimate.tempoBpm).toBe(108);
    expect(json.meterEstimate.detectedBpm).toBe(108);
    expect(json.meterEstimate.onsetSource).toBe("drums");
    expect(json.meterEstimate.runnerUp.beatsPerBar).toBe(6);
  });

  it("JSON は記録が無ければ meterEstimate を含まない（後方互換）", () => {
    const json = JSON.parse(resultToJson(baseResult()));
    expect(json).not.toHaveProperty("meterEstimate");
  });

  it("テキスト書き出しに拍子の1行が入る", () => {
    const text = resultToText(baseResult({ meterEstimate }));
    expect(text).toContain("# 拍子: 3/4 · テンポ 108");
  });

  it("テキスト書き出しは記録が無ければ拍子の行を含まない", () => {
    const text = resultToText(baseResult());
    expect(text).not.toContain("# 拍子:");
  });
});

describe("移調つき書き出し（lib/transpose.ts 連携）", () => {
  // 移調済み結果（C major から +3 = Eb major、flats 系）を模した入力
  const transposed = () =>
    baseResult({
      keyName: "Eb major",
      keyRoot: 3,
      keyMode: "major",
      segments: [
        { id: 0, start: 0, end: 2, chord: "Eb", confidence: 0.9, bassPc: 7 },
      ],
    });

  it("JSON に移調の記録が入り、キー・ベースがスペル系で書かれる", () => {
    const json = JSON.parse(
      resultToJson(transposed(), { spelling: "flats", transposeSemitones: 3 }),
    );
    expect(json.key).toBe("Eb major");
    expect(json.transpose).toEqual({
      semitones: 3,
      fromKey: "C major",
      toKey: "Eb major",
    });
    expect(json.segments[0].chord).toBe("Eb");
    expect(json.segments[0].bass).toBe("G");
  });

  it("オプション未指定では移調の記録は出ない（従来と同一）", () => {
    const json = JSON.parse(resultToJson(baseResult()));
    expect(json).not.toHaveProperty("transpose");
    expect(json.key).toBe("C major");
  });

  it("テキストに移調行と移調先キーが入り、分数表示もスペル系に従う", () => {
    const text = resultToText(transposed(), {
      spelling: "flats",
      transposeSemitones: 3,
    });
    expect(text).toContain("# キー: Eb メジャー");
    expect(text).toContain("# 移調: +3 半音（元のキー: C メジャー）");
    expect(text).toContain("Eb/G");
  });

  it("下げ移調のテキストにはカポ換算の行が入る", () => {
    // C major から −2 = Bb major（flats 系）の模擬入力
    const down = baseResult({
      keyName: "Bb major",
      keyRoot: 10,
      keyMode: "major",
      segments: [{ id: 0, start: 0, end: 2, chord: "Bb", confidence: 0.9 }],
    });
    const text = resultToText(down, {
      spelling: "flats",
      transposeSemitones: -2,
    });
    expect(text).toContain("# キー: Bb メジャー");
    expect(text).toContain("# 移調: -2 半音（元のキー: C メジャー）");
    expect(text).toContain("# カポ: Capo 2 で原曲のキーになります");
  });

  it("オプション未指定のテキストには移調行は出ない", () => {
    const text = resultToText(baseResult());
    expect(text).not.toContain("# 移調:");
    expect(text).not.toContain("# カポ:");
  });
});

describe("書き出しへの度数併記（lib/degrees.ts）", () => {
  it("JSON: セグメントに degree が付く", () => {
    const json = JSON.parse(resultToJson(baseResult()));
    expect(json.segments[0].degree).toBe("I"); // C major の C
  });

  it("JSON: N.C. には degree が付かない", () => {
    const nc: ChordSegment = {
      id: 0,
      start: 0,
      end: 2,
      chord: "N.C.",
      confidence: 0.1,
    };
    const json = JSON.parse(resultToJson(baseResult({ segments: [nc] })));
    expect(json.segments[0]).not.toHaveProperty("degree");
  });

  it("JSON: 局所キーがあれば局所キー基準の度数になる", () => {
    const localKeys: LocalKeyWindow[] = [
      {
        start: 0,
        end: 10,
        root: 9,
        mode: "minor",
        correlation: 0.9,
        margin: 0.1,
        runnerUpRoot: 0,
        runnerUpMode: "major",
      },
    ];
    const am: ChordSegment = {
      id: 0,
      start: 0,
      end: 2,
      chord: "Am",
      confidence: 0.9,
    };
    const json = JSON.parse(
      resultToJson(baseResult({ localKeys, segments: [am] })),
    );
    expect(json.segments[0].degree).toBe("i"); // 全体キー C major なら vi
  });

  it("テキスト: コードの後ろに度数が併記される", () => {
    const text = resultToText(baseResult());
    expect(text).toContain("C  I  (90%)");
  });

  it("テキスト: 層表示の分数コードにはベース度数まで付く", () => {
    const layered: ChordSegment = {
      id: 0,
      start: 0,
      end: 2,
      chord: "D",
      upperChord: "Am",
      upperExtension: "m7",
      bassPc: 2,
      confidence: 0.9,
    };
    const text = resultToText(baseResult({ segments: [layered] }));
    expect(text).toContain("Am7/D  vi7/II  (90%)");
  });
});

describe("書き出しへの小節番号併記（lib/barGrid.ts）", () => {
  // 3/4・108 BPM（「宵のひかり」の実測グリッド。1小節 = 5/3 秒）
  const yoiGrid = { bpm: 108, beatsPerBar: 3, offsetSec: 0 };

  it("JSON: グリッド設定の記録とセグメントの開始小節が付く", () => {
    const seg: ChordSegment = {
      id: 0,
      start: 98,
      end: 100,
      chord: "Am",
      confidence: 0.9,
    };
    const json = JSON.parse(
      resultToJson(baseResult({ segments: [seg] }), { barGrid: yoiGrid }),
    );
    expect(json.barGrid).toEqual({ bpm: 108, beatsPerBar: 3, offsetSec: 0 });
    expect(json.segments[0].bar).toBe(59); // 98 秒 ÷ (5/3 秒) → 59 小節
  });

  it("JSON: オフセットはグリッド起点で数えた小節になる", () => {
    const seg: ChordSegment = {
      id: 0,
      start: 1,
      end: 3,
      chord: "C",
      confidence: 0.9,
    };
    const json = JSON.parse(
      resultToJson(baseResult({ segments: [seg] }), {
        barGrid: { bpm: 120, beatsPerBar: 4, offsetSec: 2 },
      }),
    );
    // オフセット（2 秒）より前は「1小節目の途中」として小節 1
    expect(json.segments[0].bar).toBe(1);
    expect(json.barGrid.offsetSec).toBe(2);
  });

  it("JSON: グリッド未指定では bar も barGrid も付かない（従来と一致）", () => {
    const json = JSON.parse(resultToJson(baseResult()));
    expect(json).not.toHaveProperty("barGrid");
    expect(json.segments[0]).not.toHaveProperty("bar");
  });

  it("テキスト: 行頭に小節番号、ヘッダにグリッド記録が付く", () => {
    const seg: ChordSegment = {
      id: 0,
      start: 98,
      end: 100,
      chord: "C",
      confidence: 0.9,
    };
    const text = resultToText(baseResult({ segments: [seg] }), {
      barGrid: yoiGrid,
    });
    expect(text).toContain("# 小節グリッド: 108 BPM · 3/4 · オフセット 0.00 秒");
    expect(text).toContain("# 形式: 小節  開始 - 終了");
    expect(text).toContain("59小節  1:38.0 - 1:40.0  C  I  (90%)");
  });

  it("テキスト: グリッド未指定では小節番号は出ない（従来と一致）", () => {
    const text = resultToText(baseResult());
    expect(text).not.toContain("小節");
    expect(text).toContain("0:00.0 - 0:02.0  C  I  (90%)");
  });

  it("JSON: 拍子変更の区間宣言が記録され、小節番号も区間込みで付く", () => {
    // 59小節から 4/4（58小節 × 5/3 秒 = 96.667 秒で切り替わり）
    const grid = { ...yoiGrid, sections: [{ startBar: 59, beatsPerBar: 4 }] };
    const seg = (start: number): ChordSegment => ({
      id: 0,
      start,
      end: start + 2,
      chord: "C",
      confidence: 0.9,
    });
    const json = JSON.parse(
      resultToJson(baseResult({ segments: [seg(98), seg(130)] }), {
        barGrid: grid,
      }),
    );
    expect(json.barGrid).toEqual({
      bpm: 108,
      beatsPerBar: 3,
      offsetSec: 0,
      sections: [{ startBar: 59, beatsPerBar: 4 }],
    });
    expect(json.segments[0].bar).toBe(59); // 区間内 1小節目
    expect(json.segments[1].bar).toBe(74); // 単一グリッドなら 79 になる時刻
  });

  it("JSON: 区間の bpm は指定した場合のみ記録される", () => {
    const seg: ChordSegment = {
      id: 0,
      start: 0,
      end: 2,
      chord: "C",
      confidence: 0.9,
    };
    const withBpm = JSON.parse(
      resultToJson(baseResult({ segments: [seg] }), {
        barGrid: {
          bpm: 120,
          beatsPerBar: 4,
          offsetSec: 0,
          sections: [{ startBar: 5, beatsPerBar: 2, bpm: 90 }],
        },
      }),
    );
    expect(withBpm.barGrid.sections).toEqual([
      { startBar: 5, beatsPerBar: 2, bpm: 90 },
    ]);
    const inherited = JSON.parse(
      resultToJson(baseResult({ segments: [seg] }), {
        barGrid: {
          bpm: 120,
          beatsPerBar: 4,
          offsetSec: 0,
          sections: [{ startBar: 5, beatsPerBar: 2 }],
        },
      }),
    );
    expect(inherited.barGrid.sections).toEqual([
      { startBar: 5, beatsPerBar: 2 },
    ]);
    expect(inherited.barGrid.sections[0]).not.toHaveProperty("bpm");
  });

  it("テキスト: 区間宣言がヘッダに記録される", () => {
    const seg: ChordSegment = {
      id: 0,
      start: 98,
      end: 100,
      chord: "C",
      confidence: 0.9,
    };
    const text = resultToText(baseResult({ segments: [seg] }), {
      barGrid: {
        ...yoiGrid,
        sections: [
          { startBar: 59, beatsPerBar: 4 },
          { startBar: 90, beatsPerBar: 2, bpm: 90 },
        ],
      },
    });
    expect(text).toContain("# 拍子変更: 59小節から 4/4");
    expect(text).toContain("# 拍子変更: 90小節から 2/4 · 90 BPM");
    expect(text).toContain("59小節  1:38.0 - 1:40.0");
  });
});

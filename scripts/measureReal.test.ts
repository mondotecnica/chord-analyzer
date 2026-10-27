/**
 * 実曲測定ハーネスの単体テスト（正解パースと設定マトリクスのみ、音声解析は回さない）。
 */
import { describe, expect, it } from "vitest";
import { parseTruthChord, parseTruthJson, REAL_CONFIGS } from "./measureReal";

describe("parseTruthJson", () => {
  it("groundtruth 形式を正規化する", () => {
    const truth = parseTruthJson(
      {
        songId: "song-x",
        title: "Song X",
        key: "C major",
        bpm: 120,
        durationSec: 8,
        segments: [
          { startSec: 0, endSec: 4, chord: "C", bass: "C", bassPc: 0 },
          { startSec: 4, endSec: 8, chord: "Am", bass: "A", bassPc: 9 },
        ],
      },
      "fallback",
    );
    expect(truth.sourceFormat).toBe("groundtruth");
    expect(truth.key).toBe("C major");
    expect(truth.bpm).toBe(120);
    expect(truth.durationSec).toBe(8);
    expect(truth.segments).toHaveLength(2);
  });

  it("アプリ書き出し形式を正解として読み替える", () => {
    const truth = parseTruthJson(
      {
        app: "chord-analyzer-phase0",
        version: 1,
        fileName: "real-song.mp3",
        durationSec: 10.5,
        key: "A minor",
        bpmEstimate: 98,
        segments: [
          { startSec: 0, endSec: 5, chord: "Am", confidence: 0.8, edited: true },
          { startSec: 5, endSec: 10.5, chord: "F", confidence: 0.7, edited: false },
        ],
      },
      "fallback",
    );
    expect(truth.sourceFormat).toBe("app-export");
    expect(truth.title).toBe("real-song.mp3");
    expect(truth.key).toBe("A minor");
    expect(truth.bpm).toBe(98);
    expect(truth.segments[0].chord).toBe("Am");
  });

  it("durationSec が無ければ最後のセグメント終端を使う", () => {
    const truth = parseTruthJson(
      { segments: [{ startSec: 0, endSec: 3.5, chord: "G" }] },
      "fallback",
    );
    expect(truth.durationSec).toBe(3.5);
    expect(truth.key).toBeNull();
    expect(truth.bpm).toBeNull();
  });

  it("segments が無ければ例外", () => {
    expect(() => parseTruthJson({ segments: [] }, "x")).toThrow();
    expect(() => parseTruthJson({}, "x")).toThrow();
  });
});

describe("parseTruthChord", () => {
  it("語彙内コード", () => {
    expect(parseTruthChord("C")).toEqual({ root: 0, coreMode: "major", inVocabulary: true });
    expect(parseTruthChord("Am")).toEqual({ root: 9, coreMode: "minor", inVocabulary: true });
    expect(parseTruthChord("F#m")).toEqual({ root: 6, coreMode: "minor", inVocabulary: true });
  });

  it("拡張コードはコアで判定する", () => {
    expect(parseTruthChord("Cmaj7")).toEqual({ root: 0, coreMode: "major", inVocabulary: false });
    expect(parseTruthChord("C7")).toEqual({ root: 0, coreMode: "major", inVocabulary: false });
    expect(parseTruthChord("Am7")).toEqual({ root: 9, coreMode: "minor", inVocabulary: false });
    expect(parseTruthChord("Cadd9")).toEqual({ root: 0, coreMode: "major", inVocabulary: false });
  });

  it("sus は 3 度が定まらないのでコアはルートのみ", () => {
    expect(parseTruthChord("Csus4")).toEqual({ root: 0, coreMode: null, inVocabulary: false });
  });

  it("分数表記はコード部で判定し、フラット表記も受理する", () => {
    expect(parseTruthChord("C/E")).toEqual({ root: 0, coreMode: "major", inVocabulary: true });
    expect(parseTruthChord("Bb")).toEqual({ root: 10, coreMode: "major", inVocabulary: true });
  });

  it("N.C. と解釈不能な表記は null", () => {
    expect(parseTruthChord("N.C.")).toBeNull();
    expect(parseTruthChord("xyz")).toBeNull();
  });
});

describe("REAL_CONFIGS", () => {
  it("A/B の7設定が定義順に揃っている", () => {
    expect(REAL_CONFIGS.map((c) => c.id)).toEqual([
      "phase0",
      "bass",
      "unified260",
      "band220",
      "default",
      "hybrid",
      "conditional",
    ]);
    // phase0 / bass: 2026-10-27 の既定変更で化けないよう unified を明示固定
    expect(REAL_CONFIGS[0].options.bassCorrection).toBe(false);
    expect(REAL_CONFIGS[0].options.chordBand).toBeNull();
    expect(REAL_CONFIGS[0].options.bandStrategy).toBe("unified");
    expect(REAL_CONFIGS[1].options.bassCorrection).toBe(true);
    expect(REAL_CONFIGS[1].options.chordBand).toBeNull();
    expect(REAL_CONFIGS[1].options.bandStrategy).toBe("unified");
    // unified260（旧既定）: 暗黙の既定値に頼らず全て明示
    expect(REAL_CONFIGS[2].options.bassCorrection).toBe(true);
    expect(REAL_CONFIGS[2].options.chordBand).toEqual({ cutoffHz: 260, belowWeight: 0 });
    expect(REAL_CONFIGS[2].options.bandStrategy).toBe("unified");
    // band220: unified の 220Hz バリアントとして明示固定
    expect(REAL_CONFIGS[3].options.chordBand).toEqual({ cutoffHz: 220, belowWeight: 0 });
    expect(REAL_CONFIGS[3].options.bandStrategy).toBe("unified");
    // default（現在の既定）: アプリの呼び出しそのまま全オプション未指定
    expect(REAL_CONFIGS[4].options).toEqual({});
    // hybrid（Phase 1.5 分業・明示指定）: ベース補正 ON＋split。chordBand は
    // 未指定でモード判定用帯域として既定（260Hz）が効く。default と同一構成
    expect(REAL_CONFIGS[5].options.bassCorrection).toBe(true);
    expect(REAL_CONFIGS[5].options.bandStrategy).toBe("split");
    expect(REAL_CONFIGS[5].options.chordBand).toBeUndefined();
    // conditional（Phase 1.5b 条件分岐）: split-conditional
    expect(REAL_CONFIGS[6].options.bassCorrection).toBe(true);
    expect(REAL_CONFIGS[6].options.bandStrategy).toBe("split-conditional");
    expect(REAL_CONFIGS[6].options.chordBand).toBeUndefined();
  });
});

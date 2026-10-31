/**
 * ChordMini ハーネスの純粋関数の単体テスト（音声・Python 不要）。
 * 語彙マッピングと平滑化→セグメント化の基本動作を固定する。
 */
import { describe, expect, it } from "vitest";
import {
  mapVocab,
  smoothArgmaxSegments,
  toAnalysisResult,
  type ModelRun,
} from "./measureChordMini";
// config.json（tools/ 配下、git 管理外）に依存しないよう、語彙は
// 配布 config と同じ規則で生成する（ルート×14品質＋X＋N、シャープ綴り）
const ROOTS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const QUALITIES = [
  "min", "", "dim", "aug", "min6", "maj6", "min7",
  "minmaj7", "maj7", "7", "dim7", "hdim7", "sus2", "sus4",
];
const config = {
  chordVocab: [
    ...ROOTS.flatMap((r) => QUALITIES.map((q) => (q ? `${r}:${q}` : r))),
    "X",
    "N",
  ],
};

describe("ChordMini 語彙マッピング", () => {
  const vocab = mapVocab(config.chordVocab);

  it("170 クラス = 168 コード + X + N", () => {
    expect(vocab).toHaveLength(170);
    expect(vocab.filter((v) => v.nc)).toHaveLength(2);
    expect(vocab.find((v) => v.label === "X")?.isX).toBe(true);
    expect(vocab.find((v) => v.label === "N")?.isX).toBe(false);
  });

  it("品質 → コア／拡張の対応が事前登録表どおり", () => {
    const get = (label: string) => vocab.find((v) => v.label === label)!;
    expect(get("C")).toMatchObject({ root: 0, coreMode: "major", ext: "none" });
    expect(get("A:min")).toMatchObject({ root: 9, coreMode: "minor", ext: "none" });
    expect(get("B:7")).toMatchObject({ root: 11, coreMode: "major", ext: "dom7" });
    expect(get("C:maj7")).toMatchObject({ root: 0, coreMode: "major", ext: "maj7" });
    expect(get("E:min7")).toMatchObject({ root: 4, coreMode: "minor", ext: "min7" });
    expect(get("F#:hdim7")).toMatchObject({ root: 6, coreMode: "minor", ext: "hdim7" });
    expect(get("G:sus4")).toMatchObject({ root: 7, coreMode: null, ext: "sus" });
    expect(get("D:dim")).toMatchObject({ root: 2, coreMode: "minor", ext: "none" });
    expect(get("A#:aug")).toMatchObject({ root: 10, coreMode: "major", ext: "none" });
  });
});

describe("平滑化 → セグメント化", () => {
  function fakeRun(labels: number[], framesPerLabel: number): ModelRun {
    const vocab = mapVocab(config.chordVocab);
    const frames = labels.length * framesPerLabel;
    const logits = new Float32Array(frames * 170).fill(-10);
    labels.forEach((label, i) => {
      for (let t = i * framesPerLabel; t < (i + 1) * framesPerLabel; t++) {
        logits[t * 170 + label] = 10;
      }
    });
    return {
      key: "fake",
      frames,
      frameDuration: 2048 / 22050,
      durationSec: frames * (2048 / 22050),
      logits,
      vocab,
    };
  }

  it("一定ラベル区間がそのままセグメントになる", () => {
    const vocab = mapVocab(config.chordVocab);
    const cMaj7 = vocab.find((v) => v.label === "C:maj7")!.index;
    const segs = smoothArgmaxSegments(fakeRun([cMaj7], 40));
    expect(segs).toHaveLength(1);
    expect(segs[0].mapped.label).toBe("C:maj7");
    const result = toAnalysisResult(segs, segs[0].end, "fake");
    expect(result.segments[0].chord).toBe("C");
  });

  it("N は N.C. セグメントになる", () => {
    const vocab = mapVocab(config.chordVocab);
    const nIdx = vocab.find((v) => v.label === "N")!.index;
    const segs = smoothArgmaxSegments(fakeRun([nIdx], 40));
    const result = toAnalysisResult(segs, segs[0].end, "fake");
    expect(result.segments[0].chord).toBe("N.C.");
  });
});

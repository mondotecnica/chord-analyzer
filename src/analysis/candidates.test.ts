import { describe, expect, it } from "vitest";
import { analyzeAudio } from "./analyze";
import { analyzeStemsAudio } from "./analyzeStems";
import { chordChromaScore, parseChordName } from "./bassCorrection";
import {
  attachSegmentCandidates,
  segmentCandidates,
  type CandidateChromaSource,
} from "./candidates";
import { NO_CHORD } from "../lib/notes";
import type { ChordSegment } from "../types";

/**
 * Theory Engine 第1段（候補リストの露出）の単体テスト。
 * 固定する性質（measurements/theory/THEORY_ENGINE_STEP1.md の
 * 事前登録基準 2・3 に対応）:
 * - 1位候補は常に確定ラベル（root / mode / bassPc）と一致する
 * - 代替候補は集計スコア降順、マージン = 1位スコア − 候補スコア
 * - 同ルートの代替は勝者を上回らない（モード決め直しと同じ集計
 *   のため）。異ルートの代替は上回ることがあり、その場合の
 *   マージンは負（符号つきで保持する設計）
 * - N.C. セグメントはラベルを変えず、棄却候補の列（マージン非負）
 *   を持つ
 * - パイプライン経由でも、ON/OFF で判定結果は完全一致する
 */

const FRAME_DURATION = 0.05;
const NUM_FRAMES = 20; // 1 秒ぶん

/** 全フレーム同じクロマ（指定 pc 以外は 0） */
function chromaFrames(vector: Partial<Record<number, number>>): Float32Array[] {
  return Array.from({ length: NUM_FRAMES }, () => {
    const f = new Float32Array(12);
    for (const [pc, v] of Object.entries(vector)) {
      if (v !== undefined) f[Number(pc)] = v;
    }
    return f;
  });
}

const energies = new Float32Array(NUM_FRAMES).fill(1);

function source(vector: Partial<Record<number, number>>): CandidateChromaSource {
  return {
    frames: chromaFrames(vector),
    energies,
    frameDuration: FRAME_DURATION,
  };
}

function seg(chord: string, extra?: Partial<ChordSegment>): ChordSegment {
  return { id: 0, start: 0, end: 1, chord, confidence: 0.7, ...extra };
}

/** C major 的な集計（C, E, G が強い） */
const C_MAJOR_AGG = { 0: 0.55, 4: 0.5, 7: 0.45 };

describe("segmentCandidates（候補リストの露出）", () => {
  it("1位は確定ラベルと一致し、bassPc を含む構成要素を保持する", () => {
    const cands = segmentCandidates(
      seg("C", { bassPc: 4 }),
      source(C_MAJOR_AGG),
    );
    expect(cands).toHaveLength(5);
    expect(cands[0]).toMatchObject({ root: 0, mode: "major", bassPc: 4 });
    expect(cands[0].margin).toBe(0);
    // 全候補がセグメントの bassPc を共有する（ベースはセグメントの証拠）
    for (const c of cands) expect(c.bassPc).toBe(4);
  });

  it("集計が別のコードを支持しても、1位は確定ラベルで固定される（マージンは符号つき）", () => {
    // 集計は C major 的だが、確定ラベルは Am（フレーム列／ベース証拠で
    // 決まった想定）。1位は Am で、そのスコアは集計が実際に付けた値。
    const src = source(C_MAJOR_AGG);
    const cands = segmentCandidates(seg("Am"), src);
    expect(cands[0]).toMatchObject({ root: 9, mode: "minor" });
    const expectedWinnerScore = chordChromaScore(
      src.frames,
      src.energies,
      0,
      NUM_FRAMES,
      9,
      "minor",
    );
    expect(cands[0].score).toBeCloseTo(expectedWinnerScore, 12);
    // 代替の筆頭は集計の argmax（C major）で、勝者を上回るため
    // マージンは負になる（符号を潰さない設計の固定）
    const alt = cands[1];
    expect(alt).toMatchObject({ root: 0, mode: "major" });
    expect(alt.score).toBeGreaterThan(cands[0].score);
    expect(alt.margin).toBeLessThan(0);
    expect(alt.margin).toBeCloseTo(cands[0].score - alt.score, 12);
  });

  it("代替候補はスコア降順であり、各スコアは集計の再計算と一致する", () => {
    const src = source({ 9: 0.55, 1: 0.5, 4: 0.45, 7: 0.2, 2: 0.15 });
    const cands = segmentCandidates(seg("A"), src);
    for (let i = 2; i < cands.length; i++) {
      expect(cands[i - 1].score).toBeGreaterThanOrEqual(cands[i].score);
    }
    for (const c of cands) {
      const expected = chordChromaScore(
        src.frames,
        src.energies,
        0,
        NUM_FRAMES,
        c.root,
        c.mode,
      );
      expect(c.score).toBeCloseTo(expected, 12);
      expect(c.margin).toBeCloseTo(cands[0].score - c.score, 12);
    }
  });

  it("同ルートの代替候補は勝者を上回らない（モードはこの集計で決まるため）", () => {
    // A major 的な集計。確定ラベル A に対して Am のマージンは非負。
    const cands = segmentCandidates(
      seg("A"),
      source({ 9: 0.55, 1: 0.5, 4: 0.45 }),
    );
    const am = cands.find((c) => c.root === 9 && c.mode === "minor");
    expect(am).toBeDefined();
    expect(am!.margin).toBeGreaterThanOrEqual(0);
  });

  it("k の既定は 5、指定で増減し、24 を上限にクランプする", () => {
    const src = source(C_MAJOR_AGG);
    expect(segmentCandidates(seg("C"), src)).toHaveLength(5);
    expect(segmentCandidates(seg("C"), src, 3)).toHaveLength(3);
    expect(segmentCandidates(seg("C"), src, 1)).toHaveLength(1);
    expect(segmentCandidates(seg("C"), src, 100)).toHaveLength(24);
  });

  it("N.C. セグメントは棄却候補の列を持ち、マージンは非負で降順", () => {
    const cands = segmentCandidates(
      seg(NO_CHORD, { confidence: 0 }),
      source(C_MAJOR_AGG),
    );
    expect(cands).toHaveLength(5);
    expect(cands[0]).toMatchObject({ root: 0, mode: "major" });
    expect(cands[0].margin).toBe(0);
    for (let i = 1; i < cands.length; i++) {
      expect(cands[i].score).toBeLessThanOrEqual(cands[i - 1].score);
      expect(cands[i].margin).toBeGreaterThanOrEqual(0);
    }
  });

  it("attachSegmentCandidates は入力を変更せず、候補以外のフィールドを保持する", () => {
    const input = [
      seg("C", { bassPc: 4, upperChord: "Em", extension: "maj7", ncFill: "gap-fill" }),
      seg(NO_CHORD, { confidence: 0 }),
    ];
    const snapshot = JSON.parse(JSON.stringify(input));
    const out = attachSegmentCandidates(input, source(C_MAJOR_AGG));
    expect(JSON.parse(JSON.stringify(input))).toEqual(snapshot);
    const { candidates, ...rest } = out[0];
    expect(rest).toEqual(input[0]);
    expect(candidates).toHaveLength(5);
    expect(out[1].chord).toBe(NO_CHORD);
    expect(out[1].candidates).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// パイプライン経由の不変性（基準1の単体版）
// ---------------------------------------------------------------------------

const SAMPLE_RATE = 44100;

function tone(midi: number, seconds: number): Float32Array {
  const freq = 440 * Math.pow(2, (midi - 69) / 12);
  const out = new Float32Array(Math.floor(SAMPLE_RATE * seconds));
  for (let i = 0; i < out.length; i++) {
    out[i] = Math.sin(2 * Math.PI * freq * (i / SAMPLE_RATE));
  }
  return out;
}

function mixInto(dst: Float32Array, src: Float32Array, offset: number, gain: number) {
  for (let i = 0; i < src.length && offset + i < dst.length; i++) {
    dst[offset + i] += src[i] * gain;
  }
}

/** C（2秒）→ Am（2秒）の合成進行。和声トーンと低音ルートを含む */
function synthProgression(): { harmony: Float32Array; bass: Float32Array; mix: Float32Array } {
  const total = new Float32Array(SAMPLE_RATE * 4);
  const harmony = new Float32Array(SAMPLE_RATE * 4);
  const bass = new Float32Array(SAMPLE_RATE * 4);
  const chords: { tones: number[]; root: number }[] = [
    { tones: [60, 64, 67], root: 36 }, // C
    { tones: [57, 60, 64], root: 33 }, // Am
  ];
  chords.forEach((ch, idx) => {
    const offset = idx * SAMPLE_RATE * 2;
    for (const m of ch.tones) {
      mixInto(harmony, tone(m, 2), offset, 0.2);
      mixInto(total, tone(m, 2), offset, 0.2);
    }
    mixInto(bass, tone(ch.root, 2), offset, 0.25);
    mixInto(total, tone(ch.root, 2), offset, 0.25);
  });
  return { harmony, bass, mix: total };
}

function stripCandidates(segments: ChordSegment[]): unknown {
  return segments.map(({ candidates: _c, ...rest }) => rest);
}

function expectRank1MatchesLabels(segments: ChordSegment[]) {
  for (const s of segments) {
    expect(s.candidates).toBeDefined();
    expect(s.candidates!.length).toBeGreaterThan(0);
    if (s.chord === NO_CHORD) continue;
    const parsed = parseChordName(s.chord)!;
    expect(s.candidates![0].root).toBe(parsed.root);
    expect(s.candidates![0].mode).toBe(parsed.mode);
    expect(s.candidates![0].bassPc).toBe(s.bassPc);
    expect(s.candidates![0].margin).toBe(0);
  }
}

describe("パイプライン経由の候補露出（不変性）", () => {
  it("混合音経路: OFF では候補が付かず、ON でも判定結果は完全一致する", async () => {
    const { mix } = synthProgression();
    const off = await analyzeAudio(mix, SAMPLE_RATE, "synth.wav");
    for (const s of off.segments) expect(s.candidates).toBeUndefined();

    const on = await analyzeAudio(mix, SAMPLE_RATE, "synth.wav", undefined, {
      candidateRecord: true,
    });
    expect(stripCandidates(on.segments)).toEqual(off.segments);
    expectRank1MatchesLabels(on.segments);
  }, 120_000);

  it("ステム経路（analyzeStemsAudio）: OFF では候補が付かず、ON でも判定結果は完全一致する", async () => {
    const { harmony, bass, mix } = synthProgression();
    const input = {
      mixSamples: mix,
      otherSamples: harmony,
      bassSamples: bass,
      sampleRate: SAMPLE_RATE,
      fileName: "synth.wav",
    };
    const off = await analyzeStemsAudio(input);
    for (const s of off.segments) expect(s.candidates).toBeUndefined();

    const on = await analyzeStemsAudio(input, undefined, {
      candidateRecord: true,
    });
    expect(stripCandidates(on.segments)).toEqual(off.segments);
    expectRank1MatchesLabels(on.segments);
  }, 120_000);
});

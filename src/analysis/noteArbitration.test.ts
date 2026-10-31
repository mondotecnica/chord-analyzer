import { describe, expect, it } from "vitest";
import { chordName, NO_CHORD } from "../lib/notes";
import type { ChordSegment, SegmentCandidate } from "../types";
import type { NoteEvent } from "./noteEvidence";
import {
  applyNoteArbitration,
  NOTE_ARBITRATION_CONFIG,
  type NoteArbitrationConfig,
} from "./noteArbitration";
import type { TheoryProfile } from "./theoryReevaluation";

const note = (
  start: number,
  end: number,
  pitch: number,
  amplitude = 1,
): NoteEvent => ({ start, end, pitch, amplitude });

const cand = (
  root: number,
  mode: "major" | "minor",
  margin: number,
): SegmentCandidate => ({ root, mode, score: 1 - margin, margin });

let nextId = 0;
const seg = (
  start: number,
  end: number,
  root: number,
  mode: "major" | "minor",
  candidates: SegmentCandidate[],
  extra?: Partial<ChordSegment>,
): ChordSegment => ({
  id: nextId++,
  start,
  end,
  chord: chordName(root, mode),
  confidence: 0.9,
  candidates,
  ...extra,
});

const C_MAJOR: TheoryProfile = { keyRoot: 0, keyMode: "major" };
const A_MINOR: TheoryProfile = { keyRoot: 9, keyMode: "minor" };
const NO_THEORY: NoteArbitrationConfig = {
  ...NOTE_ARBITRATION_CONFIG,
  theoryAssist: false,
};

describe("NOTE_ARBITRATION_CONFIG（主構成の固定）", () => {
  it("事前登録した主構成の値を保持する", () => {
    expect(NOTE_ARBITRATION_CONFIG).toEqual({
      nearTieMargin: 0.06,
      noteFlipDelta: 0.1,
      theoryAssist: true,
    });
  });
});

describe("音符段（主軸）", () => {
  it("音符証拠が閾値を超えて挑戦者を支持すれば反転し、根拠内訳が付く", () => {
    // 勝者 C、挑戦者 G（集計は G を僅かに支持、マージン −0.05）。
    // 音符は G3/B3（和声として残る）と D4（最上声部＝旋律で除外）
    const s = seg(0, 2, 0, "major", [cand(0, "major", 0), cand(7, "major", -0.05)]);
    const notes = [note(0, 2, 55), note(0, 2, 59), note(0, 2, 62)];
    const out = applyNoteArbitration([s], { harmony: notes }, C_MAJOR);
    expect(out[0].chord).toBe("G");
    const r = out[0].noteArbitrationRationale!;
    expect(r.source).toBe("notes");
    expect(r.fromRoot).toBe(0);
    expect(r.fromMode).toBe("major");
    expect(r.acousticMargin).toBeCloseTo(-0.05);
    expect(r.challengerExplained).toBeCloseTo(1.0);
    expect(r.winnerExplained).toBeCloseTo(0.5);
    expect(r.noteDelta).toBeCloseTo(0.5);
    expect(r.theory).toBeUndefined();
    // 入力は変更しない
    expect(s.chord).toBe("C");
    expect(s.noteArbitrationRationale).toBeUndefined();
  });

  it("音符証拠が現ラベルを支持すれば反転しない", () => {
    const s = seg(0, 2, 0, "major", [cand(0, "major", 0), cand(7, "major", -0.05)]);
    // C4/G3 が残り（E4 は最上声部で除外）、説明率は C=1.0、G=0.5
    const notes = [note(0, 2, 55), note(0, 2, 60), note(0, 2, 64)];
    const out = applyNoteArbitration([s], { harmony: notes }, C_MAJOR);
    expect(out[0].chord).toBe("C");
    expect(out[0].noteArbitrationRationale).toBeUndefined();
  });

  it("音符の弱い支持（閾値以下・0でない）では反転せず、理論補助も重ねない", () => {
    // 理論だけなら反転する構成（下の理論段テストと同形）に、
    // 挑戦者への弱い音符支持（Δ≈+0.087）を置く
    const prev = seg(0, 2, 0, "major", [cand(0, "major", 0), cand(7, "major", 0.2)]);
    const mid = seg(2, 4, 2, "minor", [cand(2, "minor", 0), cand(7, "major", -0.01)]);
    const next = seg(4, 6, 0, "major", [cand(0, "major", 0), cand(7, "major", 0.2)]);
    const notes = [
      note(2, 4, 50, 1), // D3
      note(2, 4, 53, 0.8), // F3
      note(2, 4, 55, 1), // G3
      note(2, 4, 57, 0.8), // A3
      note(2, 4, 59, 1), // B3
      note(2, 4, 62, 1), // D4（最上声部、旋律として除外）
    ];
    const out = applyNoteArbitration([prev, mid, next], { harmony: notes }, C_MAJOR);
    expect(out[1].chord).toBe("Dm");
    expect(out[1].noteArbitrationRationale).toBeUndefined();
  });
});

describe("理論段（補助）", () => {
  // C - [Dm|G] - C、C 長調。音符が棄権すれば、凍結した v2 構成の
  // pairwise 優位（遷移差が駆動）が G への反転を決める構成
  const build = () => [
    seg(0, 2, 0, "major", [cand(0, "major", 0), cand(7, "major", 0.2)]),
    seg(2, 4, 2, "minor", [cand(2, "minor", 0), cand(7, "major", -0.01)]),
    seg(4, 6, 0, "major", [cand(0, "major", 0), cand(7, "major", 0.2)]),
  ];

  it("音符が棄権した接戦では理論補助がタイブレーカーとして反転させる", () => {
    const out = applyNoteArbitration(build(), { harmony: [] }, C_MAJOR);
    expect(out[1].chord).toBe("G");
    const r = out[1].noteArbitrationRationale!;
    expect(r.source).toBe("theory");
    expect(r.winnerExplained).toBeNull();
    expect(r.noteDelta).toBeNull();
    expect(r.theory).toBeDefined();
    expect(r.theory!.transitionNext).toBeCloseTo(0.006375, 6);
    expect(r.theory!.transitionPrev).toBeCloseTo(0.0015, 6);
  });

  it("理論補助 OFF（ablation）では棄権した接戦は反転しない", () => {
    const out = applyNoteArbitration(build(), { harmony: [] }, C_MAJOR, NO_THEORY);
    expect(out[1].chord).toBe("Dm");
  });

  it("説明率が同点の棄権でも理論補助の対象になる", () => {
    const s = build();
    // 中セグメントの証拠は D（Dm と G の共有音）と C（どちらにも
    // 属さない）だけが残り（E4 は最上声部で除外）、説明率は同点。
    // フォールバックは発動しない（選択後の重みは原重みの 2/3）
    const notes = [note(2, 4, 50), note(2, 4, 60), note(2, 4, 64)];
    const out = applyNoteArbitration(s, { harmony: notes }, C_MAJOR);
    expect(out[1].chord).toBe("G");
    expect(out[1].noteArbitrationRationale!.source).toBe("theory");
    expect(out[1].noteArbitrationRationale!.noteDelta).toBe(0);
  });
});

describe("否定保護と発火帯", () => {
  it("3位以下の候補は音符証拠が最強でも格上げされない（Q2 型）", () => {
    // 勝者 Am、2位 C（集計 argmax）、3位 Cm。音符は Cm を最も
    // 強く支持する（C/Eb が残り Cm の説明率 1.0）が、挑戦者の
    // 席は2位の C だけであり、C と Am は同点 → 理論も H で届かず
    const s = seg(
      0,
      2,
      9,
      "minor",
      [cand(9, "minor", 0), cand(0, "major", -0.05), cand(0, "minor", 0.02)],
    );
    const notes = [note(0, 2, 60), note(0, 2, 63), note(0, 2, 67)];
    const out = applyNoteArbitration([s], { harmony: notes }, A_MINOR);
    expect(out[0].chord).toBe("Am");
    expect(out[0].noteArbitrationRationale).toBeUndefined();
  });

  it("2位でもマージンが接戦帯を超えれば発火しない", () => {
    const s = seg(0, 2, 9, "minor", [cand(9, "minor", 0), cand(0, "major", 0.2)]);
    const notes = [note(0, 2, 60), note(0, 2, 64), note(0, 2, 55)];
    const out = applyNoteArbitration([s], { harmony: notes }, A_MINOR);
    expect(out[0].chord).toBe("Am");
  });

  it("フォールバックした証拠は棄権として扱い、音符では反転しない", () => {
    // 単一ピッチ（B4）の旋律だけの区間: 全音符が最上声部 →
    // メロディ分離で全損 → フォールバック → 棄権。理論も
    // 単独セグメントでは H に届かないため反転しない。
    // （フォールバックが無ければ B の音が G を説明率 1.0 で支持する）
    const s = seg(0, 2, 0, "major", [cand(0, "major", 0), cand(7, "major", -0.05)]);
    const notes = [note(0, 0.5, 71), note(0.5, 1, 71), note(1, 1.5, 71), note(1.5, 2, 71)];
    const out = applyNoteArbitration([s], { harmony: notes }, C_MAJOR);
    expect(out[0].chord).toBe("C");
    expect(out[0].noteArbitrationRationale).toBeUndefined();
  });
});

describe("不変条件", () => {
  it("N.C. には触らない", () => {
    const s: ChordSegment = {
      id: nextId++,
      start: 0,
      end: 2,
      chord: NO_CHORD,
      confidence: 0,
      candidates: [cand(0, "major", 0), cand(7, "major", -0.3)],
    };
    const notes = [note(0, 2, 55), note(0, 2, 59), note(0, 2, 62)];
    const out = applyNoteArbitration([s], { harmony: notes }, C_MAJOR);
    expect(out[0].chord).toBe(NO_CHORD);
  });

  it("装飾つきセグメントは反転保護される", () => {
    const s = seg(
      0,
      2,
      0,
      "major",
      [cand(0, "major", 0), cand(7, "major", -0.05)],
      { extension: "maj7" },
    );
    const notes = [note(0, 2, 55), note(0, 2, 59), note(0, 2, 62)];
    const out = applyNoteArbitration([s], { harmony: notes }, C_MAJOR);
    expect(out[0].chord).toBe("C");
  });

  it("候補が無い／1つだけのセグメントはそのまま通る", () => {
    const bare: ChordSegment = {
      id: nextId++,
      start: 0,
      end: 2,
      chord: "C",
      confidence: 0.9,
    };
    const single = seg(2, 4, 0, "major", [cand(0, "major", 0)]);
    const out = applyNoteArbitration([bare, single], { harmony: [] }, C_MAJOR);
    expect(out[0]).toBe(bare);
    expect(out[1]).toBe(single);
  });
});

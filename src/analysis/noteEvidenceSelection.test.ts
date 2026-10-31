import { describe, expect, it } from "vitest";
import { notePcShares, type NoteEvent } from "./noteEvidence";
import {
  classifyMelodyNotes,
  segmentSelectedWeights,
  selectSegmentEvidence,
  sustainFactor,
} from "./noteEvidenceSelection";

const note = (
  start: number,
  end: number,
  pitch: number,
  amplitude = 0.8,
): NoteEvent => ({ start, end, pitch, amplitude });

describe("sustainFactor", () => {
  it("基準秒数で 1 に飽和し、それ未満は線形", () => {
    expect(sustainFactor(0, 0.5)).toBe(0);
    expect(sustainFactor(0.25, 0.5)).toBeCloseTo(0.5);
    expect(sustainFactor(0.5, 0.5)).toBe(1);
    expect(sustainFactor(2.0, 0.5)).toBe(1);
  });
});

describe("classifyMelodyNotes (skyline)", () => {
  it("保持される和音の上で動く最上声部だけを旋律とする", () => {
    // C メジャーの和音（低〜中音域、4秒保持）の上に A4 の旋律
    const notes = [
      note(0, 4, 48), // C3
      note(0, 4, 52), // E3
      note(0, 4, 55), // G3
      note(0, 1, 69), // A4
      note(1, 2, 72), // C5
      note(2, 3, 69), // A4
      note(3, 4, 67), // G4
    ];
    const mask = classifyMelodyNotes(notes);
    // 和声音（C3/E3/G3）は旋律の間、最上声部にいない
    expect(mask.slice(0, 3)).toEqual([false, false, false]);
    // 最上声部の音符は全て旋律
    expect(mask.slice(3)).toEqual([true, true, true, true]);
  });

  it("和音だけの区間ではトップの和声音が旋律分類される（既知の限界）", () => {
    const notes = [note(0, 4, 48), note(0, 4, 52), note(0, 4, 55)];
    const mask = classifyMelodyNotes(notes);
    // skyline はボイシングのトップと旋律を区別できない。
    // この誤分類による全損はセグメント側のフォールバックで防ぐ
    expect(mask).toEqual([false, false, true]);
  });

  it("ボーカルチャンネルと重なる和声音符は skyline によらず旋律", () => {
    // 上に保持音（C5）があるため、skyline では C4 は旋律にならない
    const harmony = [note(0, 4, 72), note(0, 2, 60), note(2, 4, 60)];
    expect(classifyMelodyNotes(harmony)).toEqual([true, false, false]);
    // ボーカルが前半の C4 を歌うと、照合で前半だけが旋律になる
    const vocals = [note(0, 2, 60, 0.9)];
    const withVocals = classifyMelodyNotes(harmony, { vocals });
    expect(withVocals).toEqual([true, true, false]);
  });
});

describe("segmentSelectedWeights / selectSegmentEvidence", () => {
  const chordAndMelody = [
    note(0, 4, 48), // C3
    note(0, 4, 52), // E3
    note(0, 4, 55), // G3
    note(0, 4, 69), // A4（旋律、和音外の音）
  ];

  it("両機構 OFF の出力は notePcShares と一致する", () => {
    const mask = classifyMelodyNotes(chordAndMelody);
    const { weights } = segmentSelectedWeights(chordAndMelody, mask, 0, 4, {
      sustainWeighting: false,
      melodySeparation: false,
    });
    const raw = notePcShares(chordAndMelody, 0, 4);
    expect(weights).not.toBeNull();
    expect(raw).not.toBeNull();
    for (let p = 0; p < 12; p++) {
      expect(weights![p]).toBeCloseTo(raw![p], 12);
    }
  });

  it("メロディ分離で旋律の音高クラスが証拠から消える", () => {
    const [ev] = selectSegmentEvidence([{ start: 0, end: 4 }], {
      harmony: chordAndMelody,
    });
    expect(ev.pcWeights).not.toBeNull();
    // A（pc 9）は旋律のみが担っていたので 0 になる
    expect(ev.pcWeights![9]).toBe(0);
    // C/E/G に重みが集中する
    const triad = ev.pcWeights![0] + ev.pcWeights![4] + ev.pcWeights![7];
    expect(triad).toBeCloseTo(1, 6);
    expect(ev.provenance.melodyNoteCount).toBe(1);
    expect(ev.provenance.fallback).toBe(false);
  });

  it("持続重み付けで短い経過音の影響が落ちる", () => {
    const notes = [
      note(0, 4, 48, 0.8), // C3（保持）
      note(0, 4, 52, 0.8), // E3（保持）
      note(0, 4, 55, 0.8), // G3（保持）
      note(1, 1.1, 62, 0.8), // D4（0.1秒の経過音、低音域なので旋律でない）
    ];
    // 持続機構だけを切り分けるためメロディ分離は両腕とも OFF
    // （D4 は鳴っている間は最上声部になるため、分離 ON では
    // 経過音以前に旋律として除外されてしまう）
    const mask = classifyMelodyNotes(notes);
    const raw = segmentSelectedWeights(notes, mask, 0, 4, {
      sustainWeighting: false,
      melodySeparation: false,
    }).weights!;
    const sustained = segmentSelectedWeights(notes, mask, 0, 4, {
      sustainWeighting: true,
      melodySeparation: false,
    }).weights!;
    // D（pc 2）のシェアは持続重み付けで下がる（係数 0.2 が掛かる。
    // 和声音は係数 1 なので、分母も含めた正確な値は
    // (0.1×0.2) / (3×4 + 0.1×0.2) になる）
    expect(sustained[2]).toBeLessThan(raw[2]);
    expect(sustained[2]).toBeCloseTo(0.02 / 12.02, 9);
  });

  it("全音符が旋律分類される区間は原証拠へフォールバックする", () => {
    // 単旋律だけの楽節: 全音符が最上声部
    const solo = [note(0, 1, 69), note(1, 2, 72), note(2, 3, 69)];
    const [ev] = selectSegmentEvidence([{ start: 0, end: 3 }], {
      harmony: solo,
    });
    expect(ev.provenance.fallback).toBe(true);
    expect(ev.pcWeights).not.toBeNull();
    const raw = notePcShares(solo, 0, 3)!;
    for (let p = 0; p < 12; p++) {
      expect(ev.pcWeights![p]).toBeCloseTo(raw[p], 12);
    }
  });

  it("音符が重ならない区間は pcWeights が null で出自が残る", () => {
    const [ev] = selectSegmentEvidence([{ start: 10, end: 12 }], {
      harmony: chordAndMelody,
    });
    expect(ev.pcWeights).toBeNull();
    expect(ev.provenance.noteCount).toBe(0);
    expect(ev.provenance.rawWeight).toBe(0);
  });

  it("出自の割合が整合する（旋律の重みシェア）", () => {
    const [ev] = selectSegmentEvidence([{ start: 0, end: 4 }], {
      harmony: chordAndMelody,
    });
    // 4 音符とも同じ長さ・振幅なので旋律の重みシェアは 1/4
    expect(ev.provenance.noteCount).toBe(4);
    expect(ev.provenance.melodyWeightShare).toBeCloseTo(0.25, 9);
    expect(ev.provenance.selectedWeight).toBeLessThan(ev.provenance.rawWeight);
  });
});

import { describe, expect, it } from "vitest";
import type { ChordSegment } from "../types";
import {
  judgeExtension,
  type SegmentEvidence,
} from "./extensionDetection";
import {
  applyNoteBassRelabel,
  applyNoteBoundarySnap,
  noteOnsets,
  notePcShares,
  noteSegmentWitness,
  noteUnionCoverage,
  type NoteEvent,
  type NoteWitness,
} from "./noteEvidence";
import { applyNoteBassRewrite } from "./noteBassRewrite";

/**
 * 音符証拠モジュール（noteEvidence.ts）の単体テスト。
 * 検証時の Python 実装との数値整合（実キャッシュ使用）は
 * scripts/note-evidence-consistency.test.ts が担う。
 */

describe("集計の基本挙動", () => {
  it("音符が重ならない窓では shares / 証人は null", () => {
    const notes: NoteEvent[] = [{ start: 0, end: 1, pitch: 60, amplitude: 0.5 }];
    expect(notePcShares(notes, 500, 501)).toBeNull();
    expect(noteSegmentWitness(notes, 500, 501)).toBeNull();
  });

  it("シェアは重なり秒数 × 振幅で決まる", () => {
    const notes: NoteEvent[] = [
      { start: 0, end: 2, pitch: 60, amplitude: 0.5 }, // C: 重み 1.0
      { start: 0, end: 1, pitch: 64, amplitude: 0.5 }, // E: 重み 0.5
    ];
    const shares = notePcShares(notes, 0, 2)!;
    expect(shares[0]).toBeCloseTo(2 / 3, 6);
    expect(shares[4]).toBeCloseTo(1 / 3, 6);
  });
});

describe("notePcCoverage（被覆率）", () => {
  it("重なる音符は和集合で数える", () => {
    const notes: NoteEvent[] = [
      { start: 0, end: 2, pitch: 60, amplitude: 0.5 }, // C: 0–2
      { start: 1, end: 3, pitch: 72, amplitude: 0.5 }, // C: 1–3（和集合 0–3）
      { start: 3.5, end: 4, pitch: 64, amplitude: 0.5 }, // E: 0.5秒
    ];
    const w = noteSegmentWitness(notes, 0, 4)!;
    expect(w.coverage[0]).toBeCloseTo(0.75, 6);
    expect(w.coverage[4]).toBeCloseTo(0.125, 6);
  });
});

function seg(partial: Partial<ChordSegment>): ChordSegment {
  return { id: 0, start: 0, end: 4, chord: "C", confidence: 0.7, ...partial };
}

// C/E 型: 和声は C メジャー（C/E/G の長音）、ベースは E の長音。
// 混合音想定で harmony に全部入れる（プールは MIDI 50 以下 = E2 のみ）
const slashNotes: NoteEvent[] = [
  { start: 0, end: 4, pitch: 40, amplitude: 0.8 }, // E2（ベース）
  { start: 0, end: 4, pitch: 60, amplitude: 0.5 }, // C
  { start: 0, end: 4, pitch: 64, amplitude: 0.5 }, // E
  { start: 0, end: 4, pitch: 67, amplitude: 0.5 }, // G
];

const amNotes: NoteEvent[] = [
  { start: 0, end: 4, pitch: 40, amplitude: 0.8 }, // E2（ベース）
  { start: 0, end: 4, pitch: 57, amplitude: 0.5 }, // A
  { start: 0, end: 4, pitch: 60, amplitude: 0.5 }, // C
  { start: 0, end: 4, pitch: 64, amplitude: 0.5 }, // E
];

/** 指定シェアベクトルを全フレームに敷いたクロマ証拠スタブ */
function chromaStub(shares: number[]) {
  const frame = new Float32Array(shares);
  return {
    frames: Array.from({ length: 60 }, () => new Float32Array(frame)),
    energies: new Float32Array(60).fill(1),
    frameDuration: 0.1,
  };
}

// C メジャーを支持するクロマ（C/E/G が厚い）
const cChroma = chromaStub([0.3, 0, 0, 0, 0.25, 0, 0, 0.25, 0, 0, 0, 0.05]);
// Em を支持するクロマ（E/G/B が厚い）
const emChroma = chromaStub([0.02, 0, 0, 0, 0.35, 0, 0, 0.3, 0, 0, 0, 0.28]);
// Am を支持するクロマ（A/C/E が厚い）
const amChroma = chromaStub([0.28, 0, 0, 0, 0.3, 0, 0, 0.02, 0, 0.32, 0, 0]);

describe("applyNoteBassRelabel（付け替え、v2 基本形）", () => {
  it("コードは変えず、強い証拠で誤った bassPc を付け替える", () => {
    const out = applyNoteBassRelabel(
      [seg({ chord: "Em", bassPc: 2 })],
      { harmony: slashNotes },
    );
    expect(out[0].chord).toBe("Em"); // 書き換えはしない（v1 との差）
    expect(out[0].bassPc).toBe(4);
  });

  it("bassPc が無い場合は強い証拠で補強する", () => {
    const out = applyNoteBassRelabel([seg({ chord: "C" })], {
      harmony: slashNotes,
    });
    expect(out[0].bassPc).toBe(4);
  });

  it("正しい bassPc はそのまま（不変）", () => {
    const gNotes: NoteEvent[] = [
      { start: 0, end: 4, pitch: 43, amplitude: 0.8 }, // G2
      { start: 0, end: 4, pitch: 59, amplitude: 0.5 }, // B
      { start: 0, end: 4, pitch: 62, amplitude: 0.5 }, // D
      { start: 0, end: 4, pitch: 67, amplitude: 0.5 }, // G
    ];
    const out = applyNoteBassRelabel([seg({ chord: "G", bassPc: 7 })], {
      harmony: gNotes,
    });
    expect(out[0].chord).toBe("G");
    expect(out[0].bassPc).toBe(7);
  });

  it("証拠が弱い（ベースが一瞬だけ）場合は既存の bassPc を変えない", () => {
    const sparse: NoteEvent[] = [
      { start: 0, end: 0.2, pitch: 40, amplitude: 0.8 },
      { start: 0, end: 4, pitch: 60, amplitude: 0.5 },
      { start: 0, end: 4, pitch: 64, amplitude: 0.5 },
      { start: 0, end: 4, pitch: 67, amplitude: 0.5 },
    ];
    const out = applyNoteBassRelabel([seg({ chord: "C", bassPc: 0 })], {
      harmony: sparse,
    });
    expect(out[0].bassPc).toBe(0);
  });

  it("層セグメントにも付け替えだけを適用する（層の内容は不変）", () => {
    const out = applyNoteBassRelabel(
      [seg({ chord: "C#m", bassPc: 2, upperChord: "Am" })],
      { harmony: slashNotes },
    );
    expect(out[0].chord).toBe("C#m");
    expect(out[0].upperChord).toBe("Am");
    expect(out[0].bassPc).toBe(4);
  });
});

describe("applyNoteBassRewrite（厳格化した書き換え、v2 別経路）", () => {
  it("二重証拠が揃えばベース音へ潰れた Em を C/E として確定する", () => {
    const out = applyNoteBassRewrite(
      [seg({ chord: "Em", bassPc: 4 })],
      { harmony: slashNotes },
      cChroma,
    );
    expect(out[0].chord).toBe("C");
    expect(out[0].bassPc).toBe(4);
  });

  it("クロマ証拠が候補を支持しなければ、音符証拠だけでは書き換えない", () => {
    const out = applyNoteBassRewrite(
      [seg({ chord: "Em", bassPc: 4 })],
      { harmony: slashNotes },
      emChroma,
    );
    expect(out[0].chord).toBe("Em");
    expect(out[0].bassPc).toBe(4);
  });

  it("層の仮説が二重証拠で裏付けられれば昇格する（Am/E 型）", () => {
    const out = applyNoteBassRewrite(
      [seg({ chord: "Em", bassPc: 4, upperChord: "Am" })],
      { harmony: amNotes },
      amChroma,
    );
    expect(out[0].chord).toBe("Am");
    expect(out[0].bassPc).toBe(4);
    expect(out[0].upperChord).toBeUndefined();
  });

  it("upperExtension を持つ層は昇格しない（Q4 型の層保全）", () => {
    // ベースは C#、上層は Am（maj7 付き）。音符・クロマとも Am を
    // 支持する分布でも、拡張を持つ層は本体化しない。
    // 入力は stems 経路の形（harmony = other、bass = bass ステム）
    const q4Input = {
      harmony: [
        { start: 0, end: 4, pitch: 57, amplitude: 0.5 }, // A
        { start: 0, end: 4, pitch: 60, amplitude: 0.5 }, // C
        { start: 0, end: 4, pitch: 64, amplitude: 0.5 }, // E
        { start: 0, end: 4, pitch: 71, amplitude: 0.5 }, // B
      ],
      bass: [{ start: 0, end: 4, pitch: 37, amplitude: 0.8 }], // C#2
    };
    const withExt = applyNoteBassRewrite(
      [seg({ chord: "C#m", bassPc: 1, upperChord: "Am", upperExtension: "maj7" })],
      q4Input,
      amChroma,
    );
    expect(withExt[0].chord).toBe("C#m");
    expect(withExt[0].upperChord).toBe("Am");
    expect(withExt[0].upperExtension).toBe("maj7");
    // 対照: 拡張が無ければ同じ証拠で昇格する
    const withoutExt = applyNoteBassRewrite(
      [seg({ chord: "C#m", bassPc: 1, upperChord: "Am" })],
      q4Input,
      amChroma,
    );
    expect(withoutExt[0].chord).toBe("Am");
    expect(withoutExt[0].upperChord).toBeUndefined();
  });

  it("層の仮説が外れでも、修復条件と二重証拠を満たせば確定する（C/E 型）", () => {
    const out = applyNoteBassRewrite(
      [seg({ chord: "Em", bassPc: 4, upperChord: "Dm" })],
      { harmony: slashNotes },
      cChroma,
    );
    expect(out[0].chord).toBe("C");
    expect(out[0].bassPc).toBe(4);
    expect(out[0].upperChord).toBeUndefined();
  });
});

describe("applyNoteBoundarySnap（境界補正）", () => {
  const twoSegs: ChordSegment[] = [
    { id: 0, start: 0, end: 2.0, chord: "C", confidence: 0.7 },
    { id: 1, start: 2.0, end: 4.0, chord: "G", confidence: 0.7 },
  ];

  it("強いオンセットへ境界が寄る", () => {
    const onsets = noteOnsets([
      { start: 2.16, end: 3, pitch: 60, amplitude: 0.6 },
      { start: 2.18, end: 3, pitch: 64, amplitude: 0.6 },
      { start: 2.17, end: 3, pitch: 67, amplitude: 0.6 },
    ]);
    const out = applyNoteBoundarySnap(twoSegs, onsets);
    expect(out[0].end).toBeGreaterThan(2.1);
    expect(out[0].end).toBeLessThan(2.25);
    expect(out[1].start).toBe(out[0].end);
  });

  it("強い単音オンセット（ベースの拍アクセント等）には寄らない", () => {
    const single = noteOnsets([
      { start: 2.2, end: 3, pitch: 40, amplitude: 1.4 },
    ]);
    expect(applyNoteBoundarySnap(twoSegs, single)[0].end).toBe(2.0);
  });

  it("弱いオンセット・遠いオンセットには寄らない", () => {
    const weak = noteOnsets([{ start: 2.2, end: 3, pitch: 60, amplitude: 0.5 }]);
    expect(applyNoteBoundarySnap(twoSegs, weak)[0].end).toBe(2.0);
    const far = noteOnsets([
      { start: 2.6, end: 3, pitch: 60, amplitude: 0.9 },
      { start: 2.6, end: 3, pitch: 64, amplitude: 0.9 },
    ]);
    expect(applyNoteBoundarySnap(twoSegs, far)[0].end).toBe(2.0);
  });

  it("最小セグメント長を割る移動はしない", () => {
    const segs: ChordSegment[] = [
      { id: 0, start: 0, end: 0.5, chord: "C", confidence: 0.7 },
      { id: 1, start: 0.5, end: 4, chord: "G", confidence: 0.7 },
    ];
    const onsets = noteOnsets([
      { start: 0.18, end: 1, pitch: 60, amplitude: 0.9 },
      { start: 0.18, end: 1, pitch: 64, amplitude: 0.9 },
    ]);
    // 0.18 へ寄せると第1セグメントが 0.18 秒 < 0.35 秒になるため動かさない
    expect(applyNoteBoundarySnap(segs, onsets)[0].end).toBe(0.5);
  });
});

describe("noteTension の証人（judgeExtension）", () => {
  // G メジャーの窓。クロマでは F#（長7度）が倍音で膨らんでいる想定
  function evidence(fSharpShare: number): SegmentEvidence {
    const shares = new Float32Array(12);
    shares[7] = 0.3; // G
    shares[11] = 0.24; // B
    shares[2] = 0.2; // D
    shares[6] = fSharpShare; // F#
    shares[0] = 0.13 - fSharpShare + 0.15; // 残りを C 側へ寄せて合計 ≒ 1 に保つ
    const persistence = new Float32Array(12).fill(0.5);
    persistence[6] = 0.6;
    return { shares, persistence };
  }

  it("証人なしではクロマの F# シェアで GM7 が発火する", () => {
    const v = judgeExtension("G", undefined, evidence(0.15), {
      keyRoot: 7,
      keyMode: "major",
    });
    expect(v.extension).toBe("maj7");
  });

  it("replace: 音符側の実在シェアが薄ければ発火しない", () => {
    const witnessShares = new Float32Array(12);
    witnessShares[6] = 0.04; // ゴースト帯
    const v = judgeExtension("G", undefined, evidence(0.15), {
      keyRoot: 7,
      keyMode: "major",
      noteWitness: {
        shares: witnessShares,
        coverage: new Float32Array(12).fill(0.3),
        unionCoverage: 1,
        corroborationShares: null,
      },
      noteWitnessMode: "replace",
    });
    expect(v.extension).toBeUndefined();
  });

  it("replace: 音符側に実在の F# があれば発火する", () => {
    const witnessShares = new Float32Array(12);
    witnessShares[6] = 0.16;
    const v = judgeExtension("G", undefined, evidence(0.15), {
      keyRoot: 7,
      keyMode: "major",
      noteWitness: {
        shares: witnessShares,
        coverage: new Float32Array(12).fill(0.6),
        unionCoverage: 1,
        corroborationShares: null,
      },
      noteWitnessMode: "replace",
    });
    expect(v.extension).toBe("maj7");
  });

  it("bonus: 強い証人があれば床未満のクロマシェアを押し上げる", () => {
    // F# シェア 0.09（床 0.10 未満）だが適合度改善は通る分布。
    // キーは C major（G の maj7 はダイアトニック緩和を受けない）
    const shares = new Float32Array(12);
    shares[7] = 0.22; // G
    shares[11] = 0.18; // B
    shares[2] = 0.15; // D
    shares[6] = 0.09; // F#
    shares[0] = 0.12;
    shares[4] = 0.12;
    shares[9] = 0.12;
    const persistence = new Float32Array(12).fill(0.5);
    persistence[6] = 0.6;
    const ev: SegmentEvidence = { shares, persistence };
    const witnessShares = new Float32Array(12);
    witnessShares[6] = 0.14;
    const coverage = new Float32Array(12).fill(0.2);
    coverage[6] = 0.6;
    const v = judgeExtension("G", undefined, ev, {
      keyRoot: 0,
      keyMode: "major",
      noteWitness: {
        shares: witnessShares,
        coverage,
        unionCoverage: 1,
        corroborationShares: null,
      },
      noteWitnessMode: "bonus",
    });
    expect(v.extension).toBe("maj7");
    // 証人が無ければ 0.09 < 0.10 で発火しない
    const v2 = judgeExtension("G", undefined, ev, {
      keyRoot: 0,
      keyMode: "major",
    });
    expect(v2.extension).toBeUndefined();
  });
});

describe("noteUnionCoverage（和集合被覆率）", () => {
  it("重なりは和集合で数え、隙間は数えない", () => {
    const notes: NoteEvent[] = [
      { start: 0, end: 2, pitch: 60, amplitude: 0.5 },
      { start: 1, end: 3, pitch: 64, amplitude: 0.5 },
    ];
    expect(noteUnionCoverage(notes, 0, 4)).toBeCloseTo(0.75, 6);
    expect(noteUnionCoverage([], 0, 4)).toBe(0);
  });

  it("証人は二重確認プールのシェアも持つ（渡した場合のみ）", () => {
    const harmony: NoteEvent[] = [{ start: 0, end: 4, pitch: 60, amplitude: 0.5 }];
    const corr: NoteEvent[] = [{ start: 0, end: 4, pitch: 67, amplitude: 0.5 }];
    const w = noteSegmentWitness(harmony, 0, 4, corr)!;
    expect(w.unionCoverage).toBeCloseTo(1, 6);
    expect(w.corroborationShares![7]).toBeCloseTo(1, 6);
    const w2 = noteSegmentWitness(harmony, 0, 4)!;
    expect(w2.corroborationShares).toBeNull();
  });
});

describe("noteTension v2 の証人（veto / gated）", () => {
  // G メジャーの窓。クロマでは F#（長7度）が倍音で膨らんでいる想定
  function evidence(fSharpShare: number): SegmentEvidence {
    const shares = new Float32Array(12);
    shares[7] = 0.3; // G
    shares[11] = 0.24; // B
    shares[2] = 0.2; // D
    shares[6] = fSharpShare; // F#
    shares[0] = 0.13 - fSharpShare + 0.15;
    const persistence = new Float32Array(12).fill(0.5);
    persistence[6] = 0.6;
    return { shares, persistence };
  }

  /** G メジャーの証人を作る。triad は G/B/D のシェア合計が 0.95 */
  function witness(opts: {
    seventhShare: number;
    unionCoverage: number;
    corroborationSeventh: number | null;
  }): NoteWitness {
    const shares = new Float32Array(12);
    shares[7] = 0.35;
    shares[11] = 0.3;
    shares[2] = 0.3;
    shares[6] = opts.seventhShare;
    let corroborationShares: Float32Array | null = null;
    if (opts.corroborationSeventh !== null) {
      corroborationShares = new Float32Array(12);
      corroborationShares[6] = opts.corroborationSeventh;
      corroborationShares[7] = 0.4;
    }
    return {
      shares,
      coverage: new Float32Array(12).fill(0.5),
      unionCoverage: opts.unionCoverage,
      corroborationShares,
    };
  }

  const baseCtx = { keyRoot: 7, keyMode: "major" as const };

  it("veto: 密度が高く不在が二重確認できれば、通った候補を棄却する", () => {
    const v = judgeExtension("G", undefined, evidence(0.15), {
      ...baseCtx,
      noteWitness: witness({
        seventhShare: 0,
        unionCoverage: 0.9,
        corroborationSeventh: 0.01,
      }),
      noteWitnessMode: "veto",
    });
    expect(v.extension).toBeUndefined();
  });

  it("veto: 密度が低い窓では棄権する（クロマ判定が通る）", () => {
    const v = judgeExtension("G", undefined, evidence(0.15), {
      ...baseCtx,
      noteWitness: witness({
        seventhShare: 0,
        unionCoverage: 0.4,
        corroborationSeventh: 0.01,
      }),
      noteWitnessMode: "veto",
    });
    expect(v.extension).toBe("maj7");
  });

  it("veto: 二重確認プールに 7 度音があれば棄権する", () => {
    const v = judgeExtension("G", undefined, evidence(0.15), {
      ...baseCtx,
      noteWitness: witness({
        seventhShare: 0,
        unionCoverage: 0.9,
        corroborationSeventh: 0.2,
      }),
      noteWitnessMode: "veto",
    });
    expect(v.extension).toBe("maj7");
  });

  it("veto: 二重確認プールが無ければ棄権する（混合音経路の既定）", () => {
    const v = judgeExtension("G", undefined, evidence(0.15), {
      ...baseCtx,
      noteWitness: witness({
        seventhShare: 0,
        unionCoverage: 0.9,
        corroborationSeventh: null,
      }),
      noteWitnessMode: "veto",
    });
    expect(v.extension).toBe("maj7");
  });

  it("veto: 追加はしない（実在証人があっても床未満のクロマは通らない）", () => {
    const v = judgeExtension("G", undefined, evidence(0.05), {
      ...baseCtx,
      noteWitness: witness({
        seventhShare: 0.2,
        unionCoverage: 0.9,
        corroborationSeventh: 0.2,
      }),
      noteWitnessMode: "veto",
    });
    expect(v.extension).toBeUndefined();
  });

  it("gated: 発言権のある窓では実在の追加が効く（曲2 型の保存）", () => {
    // クロマ F# 0.09（床 0.10 未満、キー C major で緩和なし）。
    // 音符側に実在 0.16 があり密度も満たすため差し替えが通る
    const shares = new Float32Array(12);
    shares[7] = 0.22;
    shares[11] = 0.18;
    shares[2] = 0.15;
    shares[6] = 0.09;
    shares[0] = 0.12;
    shares[4] = 0.12;
    shares[9] = 0.12;
    const persistence = new Float32Array(12).fill(0.5);
    persistence[6] = 0.6;
    const v = judgeExtension(
      "G",
      undefined,
      { shares, persistence },
      {
        keyRoot: 0,
        keyMode: "major",
        noteWitness: witness({
          seventhShare: 0.16,
          unionCoverage: 0.95,
          corroborationSeventh: null,
        }),
        noteWitnessMode: "gated",
      },
    );
    expect(v.extension).toBe("maj7");
  });

  it("gated: 密度が低い窓の不在では棄権する（replace との差）", () => {
    const v = judgeExtension("G", undefined, evidence(0.15), {
      ...baseCtx,
      noteWitness: witness({
        seventhShare: 0,
        unionCoverage: 0.3,
        corroborationSeventh: 0.01,
      }),
      noteWitnessMode: "gated",
    });
    expect(v.extension).toBe("maj7");
  });

  it("gated: 密度＋二重確認が揃う不在では差し替えが効いて落ちる", () => {
    const v = judgeExtension("G", undefined, evidence(0.15), {
      ...baseCtx,
      noteWitness: witness({
        seventhShare: 0,
        unionCoverage: 0.95,
        corroborationSeventh: 0.01,
      }),
      noteWitnessMode: "gated",
    });
    expect(v.extension).toBeUndefined();
  });
});

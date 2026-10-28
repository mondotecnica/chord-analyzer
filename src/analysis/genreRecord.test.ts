import { describe, expect, it } from "vitest";
import { analyzeAudio } from "./analyze";
import { analyzeStemsWithStrategy, prepareStemChromas } from "./analyzeStems";

/**
 * Phase 3 後半の分離テスト: ジャンル傾向の「記録」は明示
 * オプトイン（genreRecord: true）、「消費」（第2段への係数
 * 供給）は既定 OFF であること、そして記録の有無がコード
 * ラベルを一切変えないことを保証する。
 *
 * 当初は「記録は既定 ON、消費は既定 OFF」の分割採用を提案した
 * が、推定の考察要素を検討し直す（v2）ことを優先するユーザー
 * 判断（2026-10-28）で分割採用は取らず、記録も既定 OFF として
 * 公開した。拍子（meterRecord）と同じ「記録も消費も明示
 * オプトイン」の形である。
 */

const SR = 44100;

function midiHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/** 三和音のサイン波合成（C–Am–F–G、各 2.5 秒。localKeyRecord.test.ts と同一素材） */
function synthProgression(): Float32Array {
  const chords: number[][] = [
    [48, 60, 64, 67], // C
    [45, 57, 60, 64], // Am
    [41, 53, 57, 60], // F
    [43, 55, 59, 62], // G
  ];
  const secPerChord = 2.5;
  const total = Math.floor(SR * secPerChord * chords.length);
  const out = new Float32Array(total);
  chords.forEach((notes, ci) => {
    const start = Math.floor(ci * secPerChord * SR);
    const len = Math.floor(secPerChord * SR);
    for (let i = 0; i < len; i++) {
      const t = i / SR;
      const env = Math.min(1, i / (0.02 * SR), (len - i) / (0.02 * SR));
      let v = 0;
      for (const m of notes) v += Math.sin(2 * Math.PI * midiHz(m) * t) * 0.2;
      out[start + i] = v * Math.max(0, env);
    }
  });
  return out;
}

/** 低音ルートだけのサイン波（bass ステム代用） */
function synthBass(): Float32Array {
  const roots = [36, 33, 29, 31]; // C2 A1 F1 G1
  const secPerChord = 2.5;
  const total = Math.floor(SR * secPerChord * roots.length);
  const out = new Float32Array(total);
  roots.forEach((m, ci) => {
    const start = Math.floor(ci * secPerChord * SR);
    const len = Math.floor(secPerChord * SR);
    for (let i = 0; i < len; i++) {
      const t = i / SR;
      out[start + i] = Math.sin(2 * Math.PI * midiHz(m) * t) * 0.5;
    }
  });
  return out;
}

const labelOf = (r: Awaited<ReturnType<typeof analyzeAudio>>) =>
  r.segments.map((s) => [s.start, s.end, s.chord, s.bassPc ?? -1, s.extension ?? ""]);

describe("ジャンル傾向の記録／消費の分離（混合音経路）", () => {
  it("既定では genreProfile は記録されない", async () => {
    const res = await analyzeAudio(synthProgression(), SR, "synth.wav");
    expect(res.genreProfile).toBeUndefined();
  });

  it("genreRecord: true で記録され、分布は合計 ≒ 1", async () => {
    const res = await analyzeAudio(synthProgression(), SR, "synth.wav", undefined, {
      genreRecord: true,
    });
    expect(res.genreProfile).toBeDefined();
    const sum = res.genreProfile!.scores.reduce((a, s) => a + s.score, 0);
    expect(sum).toBeCloseTo(1, 5);
    expect(res.genreProfile!.top).toBe(res.genreProfile!.scores[0].style);
  });

  it("記録の有無でコードラベルは変わらない（既定との比較）", async () => {
    const samples = synthProgression();
    const withRecord = await analyzeAudio(samples, SR, "synth.wav", undefined, {
      genreRecord: true,
    });
    const without = await analyzeAudio(samples, SR, "synth.wav");
    expect(without.genreProfile).toBeUndefined();
    expect(labelOf(withRecord)).toEqual(labelOf(without));
    expect(withRecord.keyName).toBe(without.keyName);
    expect(withRecord.bpm).toBe(without.bpm);
  });

  it("記録だけでは第2段に文脈が漏れない（extensions の結果が不変）", async () => {
    const samples = synthProgression();
    const extDefault = await analyzeAudio(samples, SR, "synth.wav", undefined, {
      extensions: true,
    });
    const extRecord = await analyzeAudio(samples, SR, "synth.wav", undefined, {
      extensions: true,
      genreRecord: true,
    });
    expect(labelOf(extDefault)).toEqual(labelOf(extRecord));
  });

  it("消費部（genre: true）でも記録は付く。単独では extensions が無いのでラベル不変", async () => {
    const samples = synthProgression();
    const consumed = await analyzeAudio(samples, SR, "synth.wav", undefined, {
      genre: true,
    });
    expect(consumed.genreProfile).toBeDefined();
    const plain = await analyzeAudio(samples, SR, "synth.wav");
    expect(labelOf(consumed)).toEqual(labelOf(plain));
  });
});

describe("ジャンル傾向の記録／消費の分離（ステム経路）", () => {
  it("既定では記録されず、明示オプトインで記録され、ラベルは変わらない", () => {
    const mix = synthProgression();
    const chromas = prepareStemChromas(mix, mix, synthBass(), SR);
    const byDefault = analyzeStemsWithStrategy(chromas, SR, "synth", "s-conditional");
    const withRecord = analyzeStemsWithStrategy(chromas, SR, "synth", "s-conditional", {
      genreRecord: true,
    });
    expect(byDefault.genreProfile).toBeUndefined();
    expect(withRecord.genreProfile).toBeDefined();
    expect(labelOf(withRecord)).toEqual(labelOf(byDefault));
  });
});

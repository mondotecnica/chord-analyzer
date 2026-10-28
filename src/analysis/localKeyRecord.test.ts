import { describe, expect, it } from "vitest";
import { analyzeAudio } from "./analyze";
import { analyzeStemsWithStrategy, prepareStemChromas } from "./analyzeStems";

/**
 * Phase 3.3 分割採用（2026-10-28）の分離テスト:
 * 局所キーの「記録」は既定 ON、「消費」（モード nudge／第2段への
 * 文脈供給）は既定 OFF のままであること、そして記録の有無が
 * コードラベルを一切変えないことを保証する。
 */

const SR = 44100;

function midiHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/** 三和音のサイン波合成（C–Am–F–G、各 2.5 秒） */
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

describe("局所キーの記録／消費の分離（混合音経路）", () => {
  it("既定では localKeys が記録される", async () => {
    const res = await analyzeAudio(synthProgression(), SR, "synth.wav");
    expect(res.localKeys).toBeDefined();
    expect(res.localKeys!.length).toBeGreaterThan(0);
  });

  it("記録の有無でコードラベルは変わらない（オプトアウトとの比較）", async () => {
    const samples = synthProgression();
    const withRecord = await analyzeAudio(samples, SR, "synth.wav");
    const without = await analyzeAudio(samples, SR, "synth.wav", undefined, {
      localKeyRecord: false,
    });
    expect(without.localKeys).toBeUndefined();
    expect(labelOf(withRecord)).toEqual(labelOf(without));
    expect(withRecord.keyName).toBe(without.keyName);
    expect(withRecord.bpm).toBe(without.bpm);
  });

  it("記録だけでは第2段に文脈が漏れない（extensions の結果が不変）", async () => {
    const samples = synthProgression();
    const extDefault = await analyzeAudio(samples, SR, "synth.wav", undefined, {
      extensions: true,
    });
    const extNoRecord = await analyzeAudio(samples, SR, "synth.wav", undefined, {
      extensions: true,
      localKeyRecord: false,
    });
    expect(labelOf(extDefault)).toEqual(labelOf(extNoRecord));
  });

  it("消費部（localKey: true）でも記録は付く", async () => {
    const res = await analyzeAudio(synthProgression(), SR, "synth.wav", undefined, {
      localKey: true,
    });
    expect(res.localKeys).toBeDefined();
  });
});

describe("局所キーの記録／消費の分離（ステム経路）", () => {
  it("既定で記録され、記録の有無でラベルは変わらない", () => {
    const mix = synthProgression();
    const chromas = prepareStemChromas(mix, mix, synthBass(), SR);
    const withRecord = analyzeStemsWithStrategy(chromas, SR, "synth", "s-conditional");
    const without = analyzeStemsWithStrategy(chromas, SR, "synth", "s-conditional", {
      localKeyRecord: false,
    });
    expect(withRecord.localKeys).toBeDefined();
    expect(withRecord.localKeys!.length).toBeGreaterThan(0);
    expect(without.localKeys).toBeUndefined();
    expect(labelOf(withRecord)).toEqual(labelOf(without));
  });
});

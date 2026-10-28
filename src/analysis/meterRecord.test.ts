import { describe, expect, it } from "vitest";
import { analyzeAudio } from "./analyze";
import { analyzeStemsWithStrategy, prepareStemChromas } from "./analyzeStems";

/**
 * Phase 3 §5 の記録／消費の分離テスト:
 * 拍子・小節推定の「記録」「消費」（BPM 仲裁）はどちらも明示
 * オプションのときだけ（採用判定で既定 ON にならなかった:
 * PHASE3_METER_RESULTS.md）であり、記録の有無と仲裁の有無が
 * コードラベルを一切変えないことを保証する
 * （PHASE3_METER_RESULTS.md の基準 C7 の単体版）。
 */

const SR = 44100;

function midiHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/** 三和音のサイン波合成（C–Am–F–G、各 2.5 秒。localKeyRecord.test.ts と同じ素材） */
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
  r.segments.map((s) => [
    s.start,
    s.end,
    s.chord,
    s.bassPc ?? -1,
    s.extension ?? "",
    s.upperChord ?? "",
  ]);

describe("拍子推定の記録／消費の分離（混合音経路）", () => {
  it("既定では記録されず、meterRecord: true で記録される", async () => {
    const samples = synthProgression();
    const def = await analyzeAudio(samples, SR, "synth.wav");
    expect(def.meterEstimate).toBeUndefined();
    const res = await analyzeAudio(samples, SR, "synth.wav", undefined, {
      meterRecord: true,
    });
    expect(res.meterEstimate).toBeDefined();
    expect(res.meterEstimate!.detectedBpm).toBe(res.bpm);
  });

  it("記録の有無でコードラベルと bpm は変わらない（仲裁 OFF 同士）", async () => {
    const samples = synthProgression();
    const withRecord = await analyzeAudio(samples, SR, "synth.wav", undefined, {
      meterRecord: true,
      meterArbitrate: false,
    });
    const without = await analyzeAudio(samples, SR, "synth.wav", undefined, {
      meterRecord: false,
      meterArbitrate: false,
    });
    expect(without.meterEstimate).toBeUndefined();
    expect(labelOf(withRecord)).toEqual(labelOf(without));
    expect(withRecord.keyName).toBe(without.keyName);
    expect(withRecord.bpm).toBe(without.bpm);
  });

  it("仲裁を有効にしてもラベルは変わらず、bpm だけが仲裁値になる", async () => {
    const samples = synthProgression();
    const plain = await analyzeAudio(samples, SR, "synth.wav", undefined, {
      meterArbitrate: false,
    });
    const arbitrated = await analyzeAudio(samples, SR, "synth.wav", undefined, {
      meterArbitrate: true,
    });
    expect(arbitrated.meterEstimate).toBeDefined();
    expect(labelOf(arbitrated)).toEqual(labelOf(plain));
    expect(arbitrated.keyName).toBe(plain.keyName);
    expect(arbitrated.bpm).toBe(arbitrated.meterEstimate!.tempoBpm);
    // 検出値の生値は記録に残る
    expect(arbitrated.meterEstimate!.detectedBpm).toBe(plain.bpm);
  });

  it("記録だけでは第2段に影響しない（extensions の結果が不変）", async () => {
    const samples = synthProgression();
    const extDefault = await analyzeAudio(samples, SR, "synth.wav", undefined, {
      extensions: true,
      meterRecord: true,
    });
    const extNoRecord = await analyzeAudio(samples, SR, "synth.wav", undefined, {
      extensions: true,
      meterRecord: false,
    });
    expect(labelOf(extDefault)).toEqual(labelOf(extNoRecord));
  });
});

describe("拍子推定の記録／消費の分離（ステム経路）", () => {
  it("明示指定で記録され、記録の有無でラベルは変わらない", async () => {
    const mix = synthProgression();
    const chromas = prepareStemChromas(mix, mix, synthBass(), SR);
    const withRecord = analyzeStemsWithStrategy(chromas, SR, "synth", "s-conditional", {
      meterRecord: true,
      meterArbitrate: false,
    });
    const without = analyzeStemsWithStrategy(chromas, SR, "synth", "s-conditional", {
      meterRecord: false,
      meterArbitrate: false,
    });
    expect(withRecord.meterEstimate).toBeDefined();
    expect(without.meterEstimate).toBeUndefined();
    expect(labelOf(withRecord)).toEqual(labelOf(without));
    expect(withRecord.bpm).toBe(without.bpm);
  });
});

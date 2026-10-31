import { describe, expect, it } from "vitest";
import { analyzeAudio } from "./analyze";
import { analyzeStemsAudio } from "./analyzeStems";
import {
  ANALYSIS_SAMPLE_RATE,
  normalizeToAnalysisRate,
} from "./sampleRate";

/**
 * 解析レート統一の恒常テスト（48kHz クロマ異常の再発防止）。
 *
 * 背景: プロジェクトのクロマは 44.1kHz 以外の入力で低域の音高
 * クラスを系統的に誤読した（48kHz で合成 Am → C# minor、
 * 実曲 05@48kHz → A# minor。診断は measurements/SUNO_YOI_ANALYSIS.md、
 * 修正は measurements/CHROMA_48K_FIX.md）。対策は「解析の全入口で
 * 44.1kHz に統一する」ことで、推定器自体は変えていない。
 * ここでは入口（analyzeAudio / analyzeStemsAudio）越しに、
 * どの入力レートでも同じ読みになることを固定する。
 * 生クロマ（computeChromagram）の SR 依存そのものは残っているので、
 * クロマを直接叩くテストではこの保証は主張しない。
 */

/** 純正弦波＋弱い倍音の静止和音（診断2 sunoYoiChromaDiagnostic2 と同じ作り） */
function synthChord(freqs: number[], sr: number, sec = 6): Float32Array {
  const n = Math.floor(sr * sec);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (const f of freqs) {
      v += Math.sin(2 * Math.PI * f * (i / sr));
      v += 0.4 * Math.sin(2 * Math.PI * f * 2 * (i / sr));
      v += 0.2 * Math.sin(2 * Math.PI * f * 3 * (i / sr));
    }
    const env = Math.min(1, i / (sr * 0.05), (n - i) / (sr * 0.05));
    out[i] = (v / freqs.length) * 0.5 * env;
  }
  return out;
}

const AM = [110, 130.81, 164.81, 220]; // A2 C3 E3 A3
const C = [130.81, 164.81, 196, 261.63]; // C3 E3 G3 C4
const RATES = [32000, 44100, 48000, 96000];

describe("normalizeToAnalysisRate", () => {
  it("44.1kHz 入力では同一配列をそのまま返す（ビット一致の担保）", () => {
    const x = new Float32Array([0.1, -0.2, 0.3]);
    const out = normalizeToAnalysisRate(x, ANALYSIS_SAMPLE_RATE);
    expect(out.samples).toBe(x);
    expect(out.sampleRate).toBe(ANALYSIS_SAMPLE_RATE);
  });

  it("48kHz 入力は 44.1kHz へリサンプルされる", () => {
    const x = new Float32Array(48000);
    const out = normalizeToAnalysisRate(x, 48000);
    expect(out.sampleRate).toBe(ANALYSIS_SAMPLE_RATE);
    expect(out.samples.length).toBe(44100);
    expect(out.samples).not.toBe(x);
  });
});

describe("解析入口のレート正規化（混合音経路）", () => {
  for (const sr of RATES) {
    it(`Am トーン @${sr}Hz → A minor と読める`, async () => {
      const res = await analyzeAudio(synthChord(AM, sr), sr, `am-${sr}.wav`);
      expect(res.sampleRate).toBe(ANALYSIS_SAMPLE_RATE);
      expect(res.keyName).toBe("A minor");
      const longest = [...res.segments].sort(
        (a, b) => b.end - b.start - (a.end - a.start),
      )[0];
      expect(longest.chord).toBe("Am");
    }, 60_000);

    it(`C トーン @${sr}Hz → C major と読める`, async () => {
      const res = await analyzeAudio(synthChord(C, sr), sr, `c-${sr}.wav`);
      expect(res.sampleRate).toBe(ANALYSIS_SAMPLE_RATE);
      expect(res.keyName).toBe("C major");
      const longest = [...res.segments].sort(
        (a, b) => b.end - b.start - (a.end - a.start),
      )[0];
      expect(longest.chord).toBe("C");
    }, 60_000);
  }
});

describe("解析入口のレート正規化（ステム経路）", () => {
  it("48kHz ステム入力でも A minor と読め、実効レートが 44.1kHz になる", async () => {
    const sr = 48000;
    const tone = synthChord(AM, sr);
    const bass = synthChord([55, 110], sr);
    const res = await analyzeStemsAudio({
      mixSamples: tone,
      otherSamples: tone,
      bassSamples: bass,
      sampleRate: sr,
      fileName: "am-stems-48k.wav",
    });
    expect(res.sampleRate).toBe(ANALYSIS_SAMPLE_RATE);
    expect(res.keyName).toBe("A minor");
  }, 60_000);
});

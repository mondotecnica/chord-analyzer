/**
 * アプリ経路（src/analysis/analyzeStems.ts の analyzeStemsAudio）が、
 * 共有コア（analyzeStemsWithStrategy の s-conditional、現行既定）の
 * 数値を再現することの検証。
 *
 * 期待値は同一素材に対する共有コアの実行結果（テスト内で算出）。
 * Phase 2 の記録 JSON（measurements/phase2/stems-results.json）は
 * legacy ゲート時代の記録であり、その再現は measureStems 側の
 * legacy 固定（measure-stems.test.ts）が担う。アプリ入口は採用済み
 * の現行既定（曲参照フレームゲート、measurements/nc/FRAME_GATE.md）
 * に従うため、記録 JSON とは一致しないのが正しい。
 * 対象は実曲1（Put Your Records On）と合成 Song D。
 * 実曲1の混合音ファイル（~/workspace/user/files/）が無い環境では
 * その曲だけスキップする。Song D はリポジトリ内素材のみで完結する。
 */
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  analyzeStemsAudio,
  analyzeStemsWithStrategy,
  prepareStemChromas,
} from "../src/analysis/analyzeStems";
import { findStemWav, STEM_SONGS } from "./measureStems";
import { loadAudioFile, measureRealSong, parseTruthJson, type RealTruth } from "./measureReal";

function materialsAvailable(slug: string): boolean {
  const spec = STEM_SONGS.find((s) => s.slug === slug);
  if (!spec) return false;
  return (
    existsSync(spec.mixPath) &&
    existsSync(spec.truthPath) &&
    findStemWav(spec.stemRoot, "other") !== null &&
    findStemWav(spec.stemRoot, "bass") !== null
  );
}

async function measureViaAppPath(slug: string) {
  const spec = STEM_SONGS.find((s) => s.slug === slug)!;
  const truth: RealTruth = parseTruthJson(
    JSON.parse(readFileSync(spec.truthPath, "utf-8")),
    spec.slug,
  );
  const mix = loadAudioFile(spec.mixPath);
  const other = loadAudioFile(findStemWav(spec.stemRoot, "other")!);
  const bass = loadAudioFile(findStemWav(spec.stemRoot, "bass")!);
  const sr = mix.sampleRate;
  const audioDur = mix.samples.length / sr;
  if (truth.durationSec > audioDur) truth.durationSec = audioDur;

  const result = await analyzeStemsAudio({
    mixSamples: mix.samples,
    otherSamples: other.samples,
    bassSamples: bass.samples,
    sampleRate: sr,
    fileName: spec.slug,
    separationModel: "htdemucs",
  });
  // 期待値: 共有コア（s-conditional、現行既定オプション）の素の結果。
  const chromas = prepareStemChromas(mix.samples, other.samples, bass.samples, sr);
  const core = analyzeStemsWithStrategy(chromas, sr, spec.slug, "s-conditional");
  return {
    result,
    measurement: measureRealSong(truth, result, "app-path"),
    expected: measureRealSong(truth, core, "core"),
  };
}

const TOLERANCE = 0.0005;

describe("アプリ経路 analyzeStemsAudio（s-conditional）の共有コア再現", () => {
  it.skipIf(!materialsAvailable("song-d"))(
    "Song D: 共有コアの数値（ルート/三和音/コア）を再現する",
    async () => {
      const { result, measurement, expected } = await measureViaAppPath("song-d");
      expect(result.mode).toBe("high-accuracy");
      expect(result.stemStrategy).toBe("s-conditional");
      expect(Math.abs(measurement.rootAccuracy - expected.rootAccuracy)).toBeLessThan(TOLERANCE);
      expect(Math.abs(measurement.triadAccuracy - expected.triadAccuracy)).toBeLessThan(TOLERANCE);
      expect(Math.abs((measurement.coreAccuracy ?? 0) - (expected.coreAccuracy ?? 0))).toBeLessThan(TOLERANCE);
    },
    300_000,
  );

  it.skipIf(!materialsAvailable("put-your-records-on"))(
    "実曲1 Put Your Records On: 共有コアの数値を再現する",
    async () => {
      const { result, measurement, expected } = await measureViaAppPath("put-your-records-on");
      expect(result.mode).toBe("high-accuracy");
      expect(result.stemStrategy).toBe("s-conditional");
      expect(Math.abs(measurement.rootAccuracy - expected.rootAccuracy)).toBeLessThan(TOLERANCE);
      expect(Math.abs(measurement.triadAccuracy - expected.triadAccuracy)).toBeLessThan(TOLERANCE);
      expect(Math.abs((measurement.coreAccuracy ?? 0) - (expected.coreAccuracy ?? 0))).toBeLessThan(TOLERANCE);
    },
    300_000,
  );
});

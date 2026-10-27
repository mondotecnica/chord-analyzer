/**
 * アプリ経路（src/analysis/analyzeStems.ts の analyzeStemsAudio）が、
 * 測定ハーネスで記録した A/B の勝者 s-conditional の数値を再現することの検証。
 *
 * 入力は stem-work/ に分離済みのステムと、STEM_BAND_AB.md の記録値
 * （measurements/phase2/stems-results.json の variants[s-conditional]）。
 * 対象は実曲1（Put Your Records On）と合成 Song D。
 * 実曲1の混合音ファイル（~/workspace/user/files/）が無い環境では
 * その曲だけスキップする。Song D はリポジトリ内素材のみで完結する。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { analyzeStemsAudio } from "../src/analysis/analyzeStems";
import {
  findStemWav,
  STEM_SONGS,
  type StemSongResult,
} from "./measureStems";
import { loadAudioFile, measureRealSong, parseTruthJson, type RealTruth } from "./measureReal";

const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));

interface RecordedExpectation {
  root: number;
  triad: number;
  core: number | null;
}

function recordedExpectation(slug: string): RecordedExpectation {
  const results = JSON.parse(
    readFileSync(
      join(PROJECT_ROOT, "measurements/phase2/stems-results.json"),
      "utf-8",
    ),
  ) as StemSongResult[];
  const song = results.find((r) => r.slug === slug);
  const variant = song?.variants.find((v) => v.strategy === "s-conditional");
  if (!variant) throw new Error(`記録値に ${slug} の s-conditional がありません`);
  return {
    root: variant.measurement.rootAccuracy,
    triad: variant.measurement.triadAccuracy,
    core: variant.measurement.coreAccuracy,
  };
}

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
  return { result, measurement: measureRealSong(truth, result, "app-path") };
}

const TOLERANCE = 0.0005;

describe("アプリ経路 analyzeStemsAudio（s-conditional）の記録値再現", () => {
  it.skipIf(!materialsAvailable("song-d"))(
    "Song D: 記録値（ルート/三和音/コア）を再現する",
    async () => {
      const expected = recordedExpectation("song-d");
      const { result, measurement } = await measureViaAppPath("song-d");
      expect(result.mode).toBe("high-accuracy");
      expect(result.stemStrategy).toBe("s-conditional");
      expect(Math.abs(measurement.rootAccuracy - expected.root)).toBeLessThan(TOLERANCE);
      expect(Math.abs(measurement.triadAccuracy - expected.triad)).toBeLessThan(TOLERANCE);
      expect(Math.abs((measurement.coreAccuracy ?? 0) - (expected.core ?? 0))).toBeLessThan(TOLERANCE);
    },
    300_000,
  );

  it.skipIf(!materialsAvailable("put-your-records-on"))(
    "実曲1 Put Your Records On: 記録値を再現する",
    async () => {
      const expected = recordedExpectation("put-your-records-on");
      const { result, measurement } = await measureViaAppPath("put-your-records-on");
      expect(result.mode).toBe("high-accuracy");
      expect(result.stemStrategy).toBe("s-conditional");
      expect(Math.abs(measurement.rootAccuracy - expected.root)).toBeLessThan(TOLERANCE);
      expect(Math.abs(measurement.triadAccuracy - expected.triad)).toBeLessThan(TOLERANCE);
      expect(Math.abs((measurement.coreAccuracy ?? 0) - (expected.core ?? 0))).toBeLessThan(TOLERANCE);
    },
    300_000,
  );
});

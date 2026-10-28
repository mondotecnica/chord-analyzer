/**
 * Phase 3 後半 測定スイート — ジャンル傾向（様式プロファイル）の
 * 記録と消費部の比較。
 *
 * 進め方は事前登録（measurements/phase3/PHASE3_GENRE_RESULTS.md）どおり:
 * - アーム定義:
 *   off    = 第2段なし（記録済みベースライン）
 *   ext    = 第2段のみ（Phase 3.1 の条件）
 *   ext33  = 第2段＋局所キー文脈（Phase 3.3 の条件）
 *   extG   = 第2段＋ジャンル文脈（本フェーズの主役）
 *   extG33 = 第2段＋局所キー文脈＋ジャンル文脈
 * - 傾向定数の較正は合成曲と Suno のみ。実曲 1–3 は触らずに検証する。
 * - 既存指標は measureSynthetic / measureReal、拡張音指標は
 *   extensionScoring の既存定義をそのまま使う。
 * - ジャンル記録（genreProfile）は全アームで記録 ON に固定する
 *   （ラッパーで genreRecord: true を明示。記録はラベルに触れ
 *   ないため、消費の有無だけがアーム差。アプリ既定は 2026-10-28
 *   のユーザー判断で OFF になったが、本ハーネスは記録済みの
 *   測定条件を再現するため明示固定する）。
 * - ステム経路のクロマは drums／vocals 付きで用意する
 *   （ジャンルの追加チャンネルの材料。mix／other／bass のクロマは
 *   追加の有無で変わらないため、off の再現性は保たれる）。
 *
 * 生成物: measurements/phase3/phase3-genre-*.json（パート別）。
 * 判定と考察は PHASE3_GENRE_RESULTS.md（手書き）に置く。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeAudio as analyzeAudioImpl, type AnalyzeOptions } from "../src/analysis/analyze";
import {
  analyzeStemsWithStrategy as analyzeStemsWithStrategyImpl,
  prepareStemChromas,
  type StemAnalysisOptions,
} from "../src/analysis/analyzeStems";

// 本ハーネスは legacy ゲート時代の記録ベースラインを再現する測定。
// アプリ既定が曲参照ゲート（measurements/nc/FRAME_GATE.md で採用）に
// 変わった後も記録を再現できるよう、全呼び出しで
// frameGate: "legacy" を固定する（measureNc.ts と同じ方針）。
// ジャンル記録も同様に、アプリ既定が OFF になった（2026-10-28）
// 後も本ハーネスの測定条件（全アーム記録 ON）を保つため
// genreRecord: true を固定する。呼び出し側が明示した値があれば
// そちらが優先される（不変性ランナーの genreRecord: false 等）。
const analyzeAudio: typeof analyzeAudioImpl = (
  samples,
  sampleRate,
  fileName,
  onProgress,
  options,
) =>
  analyzeAudioImpl(samples, sampleRate, fileName, onProgress, {
    frameGate: "legacy",
    genreRecord: true,
    ...options,
  });
const analyzeStemsWithStrategy: typeof analyzeStemsWithStrategyImpl = (
  chromas,
  sampleRate,
  fileName,
  strategy,
  opts,
) =>
  analyzeStemsWithStrategyImpl(chromas, sampleRate, fileName, strategy, {
    frameGate: "legacy",
    genreRecord: true,
    ...opts,
  });

import { fullChordName } from "../src/lib/chordDisplay";
import { NOTE_NAMES } from "../src/lib/notes";
import type { AnalysisResult, GenreProfile } from "../src/types";
import {
  measureExtensions,
  truthLabelFromFullName,
  truthLabelFromSynthetic,
  type ExtensionMeasurement,
  type ExtensionTruthSegment,
} from "./extensionScoring";
import {
  loadAudioFile,
  measureRealSong,
  parseTruthJson,
  type RealSongMeasurement,
  type RealTruth,
} from "./measureReal";
import {
  evaluateSunoFixtures,
  maj7Seconds,
  type SunoFixtureResult,
} from "./measurePhase3";
import { findStemWav, STEM_SONGS } from "./measureStems";
import { measureSong, type SongMeasurement } from "./measureSynthetic";
import {
  ADD9_SONGS,
  BLUES_SONGS,
  ROCK_SONGS,
  SECONDARY_DOMINANT_SONGS,
  SEVENTH_SONGS,
  SLASH_SONGS,
  SONGS,
  synthSong,
  type SongSpec,
} from "./synth";
import { readWav16, writeWav16 } from "./wav";

const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));
const TEST_AUDIO_DIR = join(PROJECT_ROOT, "test-audio");
const PHASE3_DIR = join(PROJECT_ROOT, "measurements", "phase3");
const SAMPLE_RATE = 44100;

function writeJson(name: string, data: unknown): void {
  mkdirSync(PHASE3_DIR, { recursive: true });
  writeFileSync(join(PHASE3_DIR, name), JSON.stringify(data, null, 2) + "\n", "utf-8");
}

export type GenreArm = "off" | "ext" | "ext33" | "extG" | "extG33";

const MIXTURE_ARMS: GenreArm[] = ["off", "ext", "extG"];
const STEMS_ARMS: GenreArm[] = ["off", "ext", "ext33", "extG", "extG33"];
const ALL_ARMS: GenreArm[] = ["off", "ext", "ext33", "extG", "extG33"];

function armOptions(arm: GenreArm): AnalyzeOptions & StemAnalysisOptions {
  switch (arm) {
    case "off":
      return { extensions: false, localKey: false, genre: false };
    case "ext":
      return { extensions: true, localKey: false, genre: false };
    case "ext33":
      return { extensions: true, localKey: true, genre: false };
    case "extG":
      return { extensions: true, localKey: false, genre: true };
    case "extG33":
      return { extensions: true, localKey: true, genre: true };
  }
}

function profileOf(result: AnalysisResult): GenreProfile | null {
  return result.genreProfile ?? null;
}

// ---------------------------------------------------------------------------
// 合成曲（混合音・既定 split、全アーム）
// ---------------------------------------------------------------------------

export interface SyntheticGenreEntry {
  songId: string;
  title: string;
  trueKey: string;
  detectedKey: string;
  arms: Record<GenreArm, SongMeasurement>;
  extArms: Record<GenreArm, ExtensionMeasurement>;
  /** extG アームの結果に記録された様式プロファイル */
  profile: GenreProfile | null;
}

const SYNTH_SPECS: SongSpec[] = [
  ...SONGS,
  ...SLASH_SONGS,
  ...SEVENTH_SONGS,
  ...SECONDARY_DOMINANT_SONGS,
  ...ADD9_SONGS,
  ...BLUES_SONGS,
  ...ROCK_SONGS,
];

export async function runGenreSynthetic(): Promise<SyntheticGenreEntry[]> {
  mkdirSync(TEST_AUDIO_DIR, { recursive: true });
  const entries: SyntheticGenreEntry[] = [];
  for (const spec of SYNTH_SPECS) {
    const { samples, truth } = synthSong(spec, SAMPLE_RATE);
    const wavPath = join(TEST_AUDIO_DIR, `${spec.id}.wav`);
    const gtPath = join(TEST_AUDIO_DIR, `${spec.id}.groundtruth.json`);
    writeWav16(wavPath, samples, SAMPLE_RATE);
    writeFileSync(gtPath, JSON.stringify(truth, null, 2) + "\n", "utf-8");
    const wav = readWav16(wavPath);

    const extTruth: ExtensionTruthSegment[] = truth.segments.flatMap((s) => {
      const label = truthLabelFromSynthetic(s);
      return label
        ? [{ startSec: s.startSec, endSec: s.endSec, label: s.fullChord ?? s.chord, truth: label }]
        : [];
    });

    const arms = {} as Record<GenreArm, SongMeasurement>;
    const extArms = {} as Record<GenreArm, ExtensionMeasurement>;
    let profile: GenreProfile | null = null;
    let detectedKey = "";
    for (const arm of ALL_ARMS) {
      const r = await analyzeAudio(
        wav.samples, wav.sampleRate, `${spec.id}.wav`, undefined, armOptions(arm),
      );
      arms[arm] = measureSong(truth, r);
      extArms[arm] = measureExtensions(extTruth, truth.durationSec, r);
      if (arm === "extG") {
        profile = profileOf(r);
        detectedKey = r.keyName;
      }
    }
    entries.push({
      songId: spec.id,
      title: spec.title,
      trueKey: spec.trueKey,
      detectedKey,
      arms,
      extArms,
      profile,
    });
  }
  writeJson("phase3-genre-synthetic.json", entries);
  return entries;
}

// ---------------------------------------------------------------------------
// 実曲（混合音: off/ext/extG、ステム: 全アーム）
// ---------------------------------------------------------------------------

const REAL_SLUGS = ["put-your-records-on", "everything", "a-hard-days-night"];

function extTruthFromReal(truth: RealTruth): ExtensionTruthSegment[] {
  return truth.segments.flatMap((s) => {
    const label = truthLabelFromFullName(s.chord);
    return label
      ? [{ startSec: s.startSec, endSec: s.endSec, label: s.chord, truth: label }]
      : [];
  });
}

export interface RealGenreMixtureEntry {
  slug: string;
  title: string;
  arms: Partial<Record<GenreArm, RealSongMeasurement>>;
  extArms: Partial<Record<GenreArm, ExtensionMeasurement>>;
  profile: GenreProfile | null;
}

export async function runGenreRealMixture(): Promise<RealGenreMixtureEntry[]> {
  const entries: RealGenreMixtureEntry[] = [];
  for (const slug of REAL_SLUGS) {
    const spec = STEM_SONGS.find((s) => s.slug === slug)!;
    if (!existsSync(spec.mixPath) || !existsSync(spec.truthPath)) continue;
    const truth: RealTruth = parseTruthJson(
      JSON.parse(readFileSync(spec.truthPath, "utf-8")),
      slug,
    );
    const mix = loadAudioFile(spec.mixPath);
    const audioDur = mix.samples.length / mix.sampleRate;
    if (truth.durationSec > audioDur) truth.durationSec = audioDur;
    const extTruth = extTruthFromReal(truth);

    const arms: RealGenreMixtureEntry["arms"] = {};
    const extArms: RealGenreMixtureEntry["extArms"] = {};
    let profile: GenreProfile | null = null;
    for (const arm of MIXTURE_ARMS) {
      const r = await analyzeAudio(
        mix.samples, mix.sampleRate, spec.mixPath, undefined, armOptions(arm),
      );
      arms[arm] = measureRealSong(truth, r, `genre-${arm}`);
      extArms[arm] = measureExtensions(extTruth, truth.durationSec, r);
      if (arm === "extG") profile = profileOf(r);
    }
    entries.push({ slug, title: spec.title, arms, extArms, profile });
  }
  writeJson("phase3-genre-real-mixture.json", entries);
  return entries;
}

export interface RealGenreStemsEntry {
  slug: string;
  title: string;
  arms: Partial<Record<GenreArm, RealSongMeasurement>>;
  extArms: Partial<Record<GenreArm, ExtensionMeasurement>>;
  maj7: Partial<Record<GenreArm, { total: number; byChord: Record<string, number> }>>;
  profile: GenreProfile | null;
}

export async function runGenreRealStems(): Promise<RealGenreStemsEntry[]> {
  const entries: RealGenreStemsEntry[] = [];
  for (const slug of [...REAL_SLUGS, "song-d"]) {
    const spec = STEM_SONGS.find((s) => s.slug === slug)!;
    const otherPath = findStemWav(spec.stemRoot, "other");
    const bassPath = findStemWav(spec.stemRoot, "bass");
    if (!otherPath || !bassPath || !existsSync(spec.mixPath) || !existsSync(spec.truthPath)) {
      continue;
    }
    const truth: RealTruth = parseTruthJson(
      JSON.parse(readFileSync(spec.truthPath, "utf-8")),
      slug,
    );
    const mix = loadAudioFile(spec.mixPath);
    const other = loadAudioFile(otherPath);
    const bass = loadAudioFile(bassPath);
    const sr = mix.sampleRate;
    const audioDur = mix.samples.length / sr;
    if (truth.durationSec > audioDur) truth.durationSec = audioDur;
    const extTruth = extTruthFromReal(truth);

    // 追加チャンネル用に drums／vocals も読む（無ければ欠落のまま）
    const drumsPath = findStemWav(spec.stemRoot, "drums");
    const vocalsPath = findStemWav(spec.stemRoot, "vocals");
    const extra =
      drumsPath && vocalsPath
        ? {
            drums: loadAudioFile(drumsPath).samples,
            vocals: loadAudioFile(vocalsPath).samples,
          }
        : undefined;
    const chromas = prepareStemChromas(mix.samples, other.samples, bass.samples, sr, extra);

    const arms: RealGenreStemsEntry["arms"] = {};
    const extArms: RealGenreStemsEntry["extArms"] = {};
    const maj7: RealGenreStemsEntry["maj7"] = {};
    let profile: GenreProfile | null = null;
    for (const arm of STEMS_ARMS) {
      const r = analyzeStemsWithStrategy(chromas, sr, slug, "s-conditional", armOptions(arm));
      arms[arm] = measureRealSong(truth, r, `genre-stems-${arm}`);
      extArms[arm] = measureExtensions(extTruth, truth.durationSec, r);
      maj7[arm] = maj7Seconds(r);
      if (arm === "extG") profile = profileOf(r);
    }
    entries.push({ slug, title: spec.title, arms, extArms, maj7, profile });
  }
  writeJson("phase3-genre-real-stems.json", entries);
  return entries;
}

// ---------------------------------------------------------------------------
// Suno 05 フィクスチャ
// ---------------------------------------------------------------------------

function segmentList(result: AnalysisResult, lo: number, hi: number): string {
  return result.segments
    .filter((s) => s.end > lo && s.start < hi)
    .map((s) => {
      const label = fullChordName(s.chord, s.extension);
      const bass = s.bassPc !== undefined ? `/${NOTE_NAMES[s.bassPc]}` : "";
      return `${s.start.toFixed(1)}–${s.end.toFixed(1)}:${label}${bass}`;
    })
    .join(" ");
}

export interface SunoGenreRun {
  fixturesExt: SunoFixtureResult;
  fixturesExtG: SunoFixtureResult;
  fixturesExtG33: SunoFixtureResult;
  mixProfile: GenreProfile | null;
  stemsProfile: GenreProfile | null;
  q2SegmentsExtG: string;
  q3SegmentsExtG: string;
  stemsMaj7: Partial<Record<GenreArm, { total: number; byChord: Record<string, number> }>>;
}

export async function runGenreSuno(): Promise<SunoGenreRun> {
  const mixPath = join(homedir(), "workspace/user/files/05.mp3");
  const stemRoot = join(PROJECT_ROOT, "stem-work/suno-05");
  const otherPath = findStemWav(stemRoot, "other");
  const bassPath = findStemWav(stemRoot, "bass");
  if (!otherPath || !bassPath || !existsSync(mixPath)) {
    throw new Error("Suno 05 の素材（MP3 / ステム）が見つかりません");
  }
  const mix = loadAudioFile(mixPath);
  const other = loadAudioFile(otherPath);
  const bass = loadAudioFile(bassPath);
  const sr = mix.sampleRate;
  const drumsPath = findStemWav(stemRoot, "drums");
  const vocalsPath = findStemWav(stemRoot, "vocals");
  const extra =
    drumsPath && vocalsPath
      ? {
          drums: loadAudioFile(drumsPath).samples,
          vocals: loadAudioFile(vocalsPath).samples,
        }
      : undefined;
  const chromas = prepareStemChromas(mix.samples, other.samples, bass.samples, sr, extra);

  const stemsResults = {} as Record<GenreArm, AnalysisResult>;
  for (const arm of STEMS_ARMS) {
    stemsResults[arm] = analyzeStemsWithStrategy(
      chromas, sr, "05.mp3", "s-conditional", armOptions(arm),
    );
  }
  const mixResults = {} as Record<GenreArm, AnalysisResult>;
  for (const arm of ALL_ARMS) {
    mixResults[arm] = await analyzeAudio(mix.samples, sr, "05.mp3", undefined, armOptions(arm));
  }

  const run: SunoGenreRun = {
    fixturesExt: evaluateSunoFixtures(
      stemsResults.off, stemsResults.ext, mixResults.off, mixResults.ext,
    ),
    fixturesExtG: evaluateSunoFixtures(
      stemsResults.off, stemsResults.extG, mixResults.off, mixResults.extG,
    ),
    fixturesExtG33: evaluateSunoFixtures(
      stemsResults.off, stemsResults.extG33, mixResults.off, mixResults.extG33,
    ),
    mixProfile: profileOf(mixResults.extG),
    stemsProfile: profileOf(stemsResults.extG),
    q2SegmentsExtG: segmentList(stemsResults.extG, 150, 170),
    q3SegmentsExtG: segmentList(stemsResults.extG, 84, 94),
    stemsMaj7: {
      ext: maj7Seconds(stemsResults.ext),
      ext33: maj7Seconds(stemsResults.ext33),
      extG: maj7Seconds(stemsResults.extG),
      extG33: maj7Seconds(stemsResults.extG33),
    },
  };
  writeJson("phase3-genre-suno.json", run);
  return run;
}

// ---------------------------------------------------------------------------
// 記録のラベル不変性（基準7）: 記録 ON（ラッパーで明示固定。
// アプリ既定は 2026-10-28 以降 OFF で、既定で記録されないこと
// 自体は src/analysis/genreRecord.test.ts が保証する）と
// genreRecord: false で、セグメントタプル＋キー＋BPM を厳密比較する
// ---------------------------------------------------------------------------

type LabelTuple = (string | number)[][];

function labelTuple(r: AnalysisResult): LabelTuple {
  return r.segments.map((s) => [
    s.start,
    s.end,
    s.chord,
    s.extension ?? "",
    s.bassPc ?? -1,
    s.confidence,
  ]);
}

function countDiffs(a: AnalysisResult, b: AnalysisResult): number {
  let diffs = 0;
  if (a.keyName !== b.keyName) diffs += 1;
  if (a.bpm !== b.bpm) diffs += 1;
  const ta = labelTuple(a);
  const tb = labelTuple(b);
  if (ta.length !== tb.length) diffs += Math.abs(ta.length - tb.length);
  const n = Math.min(ta.length, tb.length);
  for (let i = 0; i < n; i++) {
    if (JSON.stringify(ta[i]) !== JSON.stringify(tb[i])) diffs += 1;
  }
  return diffs;
}

export interface InvarianceEntry {
  suite: string;
  diffs: number;
  profilePresentInDefault: boolean;
}

export async function runGenreInvariance(): Promise<InvarianceEntry[]> {
  const entries: InvarianceEntry[] = [];
  const push = (suite: string, a: AnalysisResult, b: AnalysisResult) =>
    entries.push({
      suite,
      diffs: countDiffs(a, b),
      profilePresentInDefault: a.genreProfile !== undefined,
    });

  // 合成 A–I（混合音・記録 ON 固定）
  mkdirSync(TEST_AUDIO_DIR, { recursive: true });
  for (const spec of SYNTH_SPECS) {
    const { samples } = synthSong(spec, SAMPLE_RATE);
    const wavPath = join(TEST_AUDIO_DIR, `${spec.id}.wav`);
    writeWav16(wavPath, samples, SAMPLE_RATE);
    const wav = readWav16(wavPath);
    const def = await analyzeAudio(wav.samples, wav.sampleRate, `${spec.id}.wav`);
    const off = await analyzeAudio(wav.samples, wav.sampleRate, `${spec.id}.wav`, undefined, {
      genreRecord: false,
    });
    push(`synthetic-${spec.id}`, def, off);
  }

  // 実曲 混合音＋ステム、Suno 両モード
  for (const slug of [...REAL_SLUGS, "song-d"]) {
    const spec = STEM_SONGS.find((s) => s.slug === slug)!;
    if (!existsSync(spec.mixPath)) continue;
    const mix = loadAudioFile(spec.mixPath);
    const def = await analyzeAudio(mix.samples, mix.sampleRate, spec.mixPath);
    const off = await analyzeAudio(mix.samples, mix.sampleRate, spec.mixPath, undefined, {
      genreRecord: false,
    });
    push(`real-mixture-${slug}`, def, off);

    const otherPath = findStemWav(spec.stemRoot, "other");
    const bassPath = findStemWav(spec.stemRoot, "bass");
    if (otherPath && bassPath) {
      const other = loadAudioFile(otherPath);
      const bass = loadAudioFile(bassPath);
      const chromas = prepareStemChromas(mix.samples, other.samples, bass.samples, mix.sampleRate);
      const sDef = analyzeStemsWithStrategy(chromas, mix.sampleRate, slug, "s-conditional");
      const sOff = analyzeStemsWithStrategy(chromas, mix.sampleRate, slug, "s-conditional", {
        genreRecord: false,
      });
      push(`real-stems-${slug}`, sDef, sOff);
    }
  }

  const sunoMixPath = join(homedir(), "workspace/user/files/05.mp3");
  const sunoRoot = join(PROJECT_ROOT, "stem-work/suno-05");
  const sOther = findStemWav(sunoRoot, "other");
  const sBass = findStemWav(sunoRoot, "bass");
  if (existsSync(sunoMixPath) && sOther && sBass) {
    const mix = loadAudioFile(sunoMixPath);
    const def = await analyzeAudio(mix.samples, mix.sampleRate, "05.mp3");
    const off = await analyzeAudio(mix.samples, mix.sampleRate, "05.mp3", undefined, {
      genreRecord: false,
    });
    push("suno-mixture", def, off);
    const other = loadAudioFile(sOther);
    const bass = loadAudioFile(sBass);
    const chromas = prepareStemChromas(mix.samples, other.samples, bass.samples, mix.sampleRate);
    const sDef = analyzeStemsWithStrategy(chromas, mix.sampleRate, "05.mp3", "s-conditional");
    const sOff = analyzeStemsWithStrategy(chromas, mix.sampleRate, "05.mp3", "s-conditional", {
      genreRecord: false,
    });
    push("suno-stems", sDef, sOff);
  }

  writeJson("phase3-genre-invariance.json", entries);
  return entries;
}

/**
 * Phase 3 §5 測定スイート — 拍子・小節推定モジュール。
 *
 * 進め方は事前登録（measurements/phase3/PHASE3_METER_RESULTS.md）どおり:
 * - アーム定義:
 *   off = meterRecord: false（推定なし。ラベル・bpm は従来どおり）
 *   rec = 記録のみ（meterRecord: true, meterArbitrate: false。
 *         bpm は検出値のまま。記録は明示オプトインのため明示する）
 *   def = アプリ既定（meter オプション無指定。採用判定後は
 *         記録・仲裁とも OFF が既定）
 * - 定数の較正は合成曲と Suno のみ。実曲 1–3 は触らずに検証する。
 * - 既存指標は measureSynthetic / measureReal の既存定義をそのまま使う。
 * - ステム経路のクロマは drums／vocals 付きで用意する
 *   （拍子モジュールの包絡出所が drums 優先になる経路も検証するため。
 *   mix／other／bass のクロマは追加の有無で変わらない）。
 *
 * 生成物: measurements/phase3/phase3-meter-*.json（パート別）。
 * 判定と考察は PHASE3_METER_RESULTS.md（手書き）に置く。
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
const analyzeAudio: typeof analyzeAudioImpl = (
  samples,
  sampleRate,
  fileName,
  onProgress,
  options,
) =>
  analyzeAudioImpl(samples, sampleRate, fileName, onProgress, {
    frameGate: "legacy",
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
    ...opts,
  });

import type { AnalysisResult, MeterEstimate } from "../src/types";
import {
  loadAudioFile,
  measureRealSong,
  parseTruthJson,
  type RealSongMeasurement,
  type RealTruth,
} from "./measureReal";
import { evaluateSunoFixtures, type SunoFixtureResult } from "./measurePhase3";
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

export type MeterArm = "off" | "rec" | "def";

function armOptions(arm: MeterArm): AnalyzeOptions & StemAnalysisOptions {
  switch (arm) {
    case "off":
      return { meterRecord: false };
    case "rec":
      // 記録は明示オプトイン（採用判定で既定 ON にならなかった）なので
      // 記録アームは meterRecord: true を明示する。仲裁は切る。
      return { meterRecord: true, meterArbitrate: false };
    case "def":
      return {};
  }
}

export interface MeterArmEntry {
  /** 結果の bpm（off/rec では検出値、def では既定の仲裁設定に従う） */
  resultBpm: number | null;
  /** 記録された拍子推定（off では null） */
  meter: MeterEstimate | null;
}

function armEntry(r: AnalysisResult): MeterArmEntry {
  return { resultBpm: r.bpm, meter: r.meterEstimate ?? null };
}

// ---------------------------------------------------------------------------
// ラベル不変性（基準 C7）: セグメントタプル＋キーの厳密比較
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
    s.upperChord ?? "",
    s.upperExtension ?? "",
    (s.addTones ?? []).join("+"),
  ]);
}

export interface InvarianceEntry {
  suite: string;
  /** rec（記録 ON）vs off のセグメントタプル＋キーの差分数（0 でなければならない） */
  diffs: number;
  /** rec と off で bpm が異なるか（記録だけなら起こらない） */
  bpmDiff: boolean;
  /** bpm が異なる場合、それが仲裁（スケール ≠ 1）と一致しているか */
  bpmDiffExplainedByArbitration: boolean;
  meterPresentInRecordArm: boolean;
}

function invariance(suite: string, rec: AnalysisResult, off: AnalysisResult): InvarianceEntry {
  let diffs = 0;
  if (rec.keyName !== off.keyName) diffs += 1;
  const ta = labelTuple(rec);
  const tb = labelTuple(off);
  if (ta.length !== tb.length) diffs += Math.abs(ta.length - tb.length);
  const n = Math.min(ta.length, tb.length);
  for (let i = 0; i < n; i++) {
    if (JSON.stringify(ta[i]) !== JSON.stringify(tb[i])) diffs += 1;
  }
  const bpmDiff = rec.bpm !== off.bpm;
  return {
    suite,
    diffs,
    bpmDiff,
    bpmDiffExplainedByArbitration:
      !bpmDiff ||
      (rec.meterEstimate !== undefined && rec.meterEstimate.tempoScale !== 1),
    meterPresentInRecordArm: rec.meterEstimate !== undefined,
  };
}

// ---------------------------------------------------------------------------
// 合成曲（混合音・アプリ既定パイプライン）
// ---------------------------------------------------------------------------

const SYNTH_SPECS: SongSpec[] = [
  ...SONGS,
  ...SLASH_SONGS,
  ...SEVENTH_SONGS,
  ...SECONDARY_DOMINANT_SONGS,
  ...ADD9_SONGS,
  ...BLUES_SONGS,
  ...ROCK_SONGS,
];

export interface SyntheticMeterEntry {
  songId: string;
  trueBpm: number;
  trueBeatsPerBar: number;
  arms: Record<MeterArm, MeterArmEntry>;
  /** off アームの既存指標（ベースライン再現の確認用） */
  offMeasurement: SongMeasurement;
}

export async function runMeterSynthetic(): Promise<SyntheticMeterEntry[]> {
  mkdirSync(TEST_AUDIO_DIR, { recursive: true });
  const entries: SyntheticMeterEntry[] = [];
  for (const spec of SYNTH_SPECS) {
    const { samples, truth } = synthSong(spec, SAMPLE_RATE);
    const wavPath = join(TEST_AUDIO_DIR, `${spec.id}.wav`);
    const gtPath = join(TEST_AUDIO_DIR, `${spec.id}.groundtruth.json`);
    writeWav16(wavPath, samples, SAMPLE_RATE);
    writeFileSync(gtPath, JSON.stringify(truth, null, 2) + "\n", "utf-8");
    const wav = readWav16(wavPath);

    const results = {} as Record<MeterArm, AnalysisResult>;
    for (const arm of ["off", "rec", "def"] as const) {
      results[arm] = await analyzeAudio(
        wav.samples, wav.sampleRate, `${spec.id}.wav`, undefined, armOptions(arm),
      );
    }
    entries.push({
      songId: spec.id,
      trueBpm: spec.bpm,
      trueBeatsPerBar: spec.beatsPerBar,
      arms: {
        off: armEntry(results.off),
        rec: armEntry(results.rec),
        def: armEntry(results.def),
      },
      offMeasurement: measureSong(truth, results.off),
    });
    invarianceEntries.push(
      invariance(`synthetic-${spec.id}`, results.rec, results.off),
    );
  }
  writeJson("phase3-meter-synthetic.json", entries);
  return entries;
}

// ---------------------------------------------------------------------------
// 実曲（混合音・ステム）
// ---------------------------------------------------------------------------

const REAL_SLUGS = ["put-your-records-on", "everything", "a-hard-days-night"];

export interface RealMeterEntry {
  slug: string;
  title: string;
  arms: Partial<Record<MeterArm, MeterArmEntry>>;
  measurements: Partial<Record<MeterArm, RealSongMeasurement>>;
}

const invarianceEntries: InvarianceEntry[] = [];

function loadTruth(slug: string, spec: (typeof STEM_SONGS)[number]): RealTruth {
  const truth: RealTruth = parseTruthJson(
    JSON.parse(readFileSync(spec.truthPath, "utf-8")),
    slug,
  );
  return truth;
}

export async function runMeterRealMixture(): Promise<RealMeterEntry[]> {
  const entries: RealMeterEntry[] = [];
  for (const slug of REAL_SLUGS) {
    const spec = STEM_SONGS.find((s) => s.slug === slug)!;
    if (!existsSync(spec.mixPath) || !existsSync(spec.truthPath)) continue;
    const truth = loadTruth(slug, spec);
    const mix = loadAudioFile(spec.mixPath);
    const audioDur = mix.samples.length / mix.sampleRate;
    if (truth.durationSec > audioDur) truth.durationSec = audioDur;

    const arms: RealMeterEntry["arms"] = {};
    const measurements: RealMeterEntry["measurements"] = {};
    const results = {} as Partial<Record<MeterArm, AnalysisResult>>;
    for (const arm of ["off", "rec", "def"] as const) {
      const r = await analyzeAudio(
        mix.samples, mix.sampleRate, spec.mixPath, undefined, armOptions(arm),
      );
      results[arm] = r;
      arms[arm] = armEntry(r);
      measurements[arm] = measureRealSong(truth, r, `meter-${arm}`);
    }
    entries.push({ slug, title: spec.title, arms, measurements });
    invarianceEntries.push(
      invariance(`real-mixture-${slug}`, results.rec!, results.off!),
    );
  }
  writeJson("phase3-meter-real-mixture.json", entries);
  return entries;
}

export async function runMeterRealStems(): Promise<RealMeterEntry[]> {
  const entries: RealMeterEntry[] = [];
  for (const slug of [...REAL_SLUGS, "song-d"]) {
    const spec = STEM_SONGS.find((s) => s.slug === slug)!;
    const otherPath = findStemWav(spec.stemRoot, "other");
    const bassPath = findStemWav(spec.stemRoot, "bass");
    if (!otherPath || !bassPath || !existsSync(spec.mixPath) || !existsSync(spec.truthPath)) {
      continue;
    }
    const truth = loadTruth(slug, spec);
    const mix = loadAudioFile(spec.mixPath);
    const other = loadAudioFile(otherPath);
    const bass = loadAudioFile(bassPath);
    const sr = mix.sampleRate;
    const audioDur = mix.samples.length / sr;
    if (truth.durationSec > audioDur) truth.durationSec = audioDur;

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

    const arms: RealMeterEntry["arms"] = {};
    const measurements: RealMeterEntry["measurements"] = {};
    const results = {} as Partial<Record<MeterArm, AnalysisResult>>;
    for (const arm of ["off", "rec", "def"] as const) {
      const r = analyzeStemsWithStrategy(chromas, sr, slug, "s-conditional", armOptions(arm));
      results[arm] = r;
      arms[arm] = armEntry(r);
      measurements[arm] = measureRealSong(truth, r, `meter-stems-${arm}`);
    }
    entries.push({ slug, title: spec.title, arms, measurements });
    invarianceEntries.push(
      invariance(`real-stems-${slug}`, results.rec!, results.off!),
    );
  }
  writeJson("phase3-meter-real-stems.json", entries);
  return entries;
}

// ---------------------------------------------------------------------------
// Suno 05（陽性ケース: 3/4・108。両モード＋フィクスチャ不変性 C8）
// ---------------------------------------------------------------------------

export interface SunoMeterRun {
  mixArms: Record<MeterArm, MeterArmEntry>;
  stemsArms: Record<MeterArm, MeterArmEntry>;
  /** C8: フィクスチャは meter の有無（既定 vs meterRecord: false）で同一でなければならない */
  fixturesDefault: SunoFixtureResult;
  fixturesMeterOff: SunoFixtureResult;
}

export async function runMeterSuno(): Promise<SunoMeterRun> {
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

  const mixResults = {} as Record<MeterArm, AnalysisResult>;
  const stemsResults = {} as Record<MeterArm, AnalysisResult>;
  for (const arm of ["off", "rec", "def"] as const) {
    mixResults[arm] = await analyzeAudio(mix.samples, sr, "05.mp3", undefined, armOptions(arm));
    stemsResults[arm] = analyzeStemsWithStrategy(chromas, sr, "05.mp3", "s-conditional", armOptions(arm));
  }
  invarianceEntries.push(invariance("suno-mixture", mixResults.rec, mixResults.off));
  invarianceEntries.push(invariance("suno-stems", stemsResults.rec, stemsResults.off));

  // C8 用: 第2段 ON の結果同士でもフィクスチャが変わらないこと。
  // 記録は明示オプトインのため、こちらは meterRecord: true を明示して
  // 「記録あり」と「記録なし」の比較にする
  const mixExtDefault = await analyzeAudio(mix.samples, sr, "05.mp3", undefined, {
    extensions: true,
    meterRecord: true,
  });
  const stemsExtDefault = analyzeStemsWithStrategy(chromas, sr, "05.mp3", "s-conditional", {
    extensions: true,
    meterRecord: true,
  });
  const mixExtOff = await analyzeAudio(mix.samples, sr, "05.mp3", undefined, {
    extensions: true,
    meterRecord: false,
  });
  const stemsExtOff = analyzeStemsWithStrategy(chromas, sr, "05.mp3", "s-conditional", {
    extensions: true,
    meterRecord: false,
  });

  const run: SunoMeterRun = {
    mixArms: {
      off: armEntry(mixResults.off),
      rec: armEntry(mixResults.rec),
      def: armEntry(mixResults.def),
    },
    stemsArms: {
      off: armEntry(stemsResults.off),
      rec: armEntry(stemsResults.rec),
      def: armEntry(stemsResults.def),
    },
    fixturesDefault: evaluateSunoFixtures(
      stemsResults.off, stemsExtDefault, mixResults.off, mixExtDefault,
    ),
    fixturesMeterOff: evaluateSunoFixtures(
      stemsResults.off, stemsExtOff, mixResults.off, mixExtOff,
    ),
  };
  writeJson("phase3-meter-suno.json", run);
  return run;
}

// ---------------------------------------------------------------------------
// 不変性サマリ（全パートの後に呼ぶ）
// ---------------------------------------------------------------------------

export function writeMeterInvariance(): InvarianceEntry[] {
  const entries = [...invarianceEntries];
  writeJson("phase3-meter-invariance.json", entries);
  return entries;
}

export function resetMeterInvariance(): void {
  invarianceEntries.length = 0;
}

/**
 * Phase 1.5 分業（hybrid）構成の測定ハーネス。
 *
 * 背景（measurements/PHASE1_STEP3.md）: 実曲では上帯域はモードに効くが
 * ルートに逆効果だった。分業（bandStrategy: "split"、ルート=全帯域＋
 * ベース補正／モード=上帯域 260Hz）が両取りできるかを測る。
 *
 * 1. 合成回帰: Songs A–D に split を適用し、上帯域ハーネス
 *    （scripts/measureUpperBand.ts）と同一手順（WAV 往復あり）で測定する。
 *    対照値は PHASE1_UPPERBAND.md の記録:
 *    - bass 設定（全帯域＋補正）: A–C ルート 95.4% / 三和音 86.4%
 *    - default-260（現在の既定）: A–C ルート 96.9% / 三和音 92.1%、
 *      Song D ルート 87.2% / 分数表示の正しさ 87.2%
 * 2. 実曲感度: Put Your Records On の hybrid 検出結果に対し、正解境界を
 *    ±0.3 秒シフトしたときのルート／三和音の動きを測る（Step 3 の
 *    default 感度チェックと同じ方法）。音声・正解が無い環境では null。
 *
 * 出力: measurements/hybrid-results.json
 * （レポート measurements/PHASE1_5_HYBRID.md はこの JSON の数字をもとに作成）
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeAudio, type AnalyzeOptions } from "../src/analysis/analyze";
import {
  loadAudioFile,
  measureRealSong,
  parseTruthJson,
  type RealSongMeasurement,
  type RealTruth,
} from "./measureReal";
import { measureSong } from "./measureSynthetic";
import { measureSlash } from "./measurePhase1Step2";
import { SONGS, SLASH_SONGS, synthSong, type SongSpec } from "./synth";
import { readWav16, writeWav16 } from "./wav";

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TEST_AUDIO_DIR = join(PROJECT_ROOT, "test-audio");
const MEASUREMENTS_DIR = join(PROJECT_ROOT, "measurements");
const SAMPLE_RATE = 44100;

/** 分業（hybrid）の解析オプション。measureReal.ts の REAL_CONFIGS と同一 */
export const HYBRID_OPTIONS: AnalyzeOptions = {
  bassCorrection: true,
  bandStrategy: "split",
};

export interface HybridSongResult {
  songId: string;
  title: string;
  trueKey: string;
  detectedKey: string;
  rootAccuracy: number;
  triadAccuracy: number;
  ncShare: number;
  rootWrongSec: number;
  modeFlipSec: number;
  slashAccuracy: number;
  spuriousSlashSec: number;
  topConfusions: { gt: string; det: string; sec: number }[];
}

export interface HybridSyntheticResult {
  songs: HybridSongResult[];
  /** Songs A–C の時間加重集計 */
  acRootAccuracy: number;
  acTriadAccuracy: number;
  acSpuriousSlashSec: number;
  /** Song D 単体 */
  dRootAccuracy: number;
  dTriadAccuracy: number;
  dSlashAccuracy: number;
  dKeyCorrect: boolean;
}

export async function runHybridSynthetic(): Promise<HybridSyntheticResult> {
  mkdirSync(TEST_AUDIO_DIR, { recursive: true });
  const specs: SongSpec[] = [...SONGS, ...SLASH_SONGS];
  const songs: HybridSongResult[] = [];
  const durations: number[] = [];
  for (const spec of specs) {
    const { samples, truth } = synthSong(spec, SAMPLE_RATE);
    const wavPath = join(TEST_AUDIO_DIR, `${spec.id}.wav`);
    writeWav16(wavPath, samples, SAMPLE_RATE);
    const wav = readWav16(wavPath);
    const result = await analyzeAudio(
      wav.samples,
      wav.sampleRate,
      `${spec.id}.wav`,
      undefined,
      HYBRID_OPTIONS,
    );
    const m = measureSong(truth, result);
    const slash = measureSlash(truth, result);
    durations.push(truth.durationSec);
    songs.push({
      songId: spec.id,
      title: truth.title,
      trueKey: truth.key,
      detectedKey: m.detectedKey,
      rootAccuracy: m.rootAccuracy,
      triadAccuracy: m.triadAccuracy,
      ncShare: m.ncShare,
      rootWrongSec: m.rootWrongSec,
      modeFlipSec: m.modeFlipSec,
      slashAccuracy: slash.slashAccuracy,
      spuriousSlashSec: slash.spuriousSlashSec,
      topConfusions: m.confusions.slice(0, 3),
    });
  }
  const ac = songs.slice(0, SONGS.length);
  const acDurs = durations.slice(0, SONGS.length);
  const totalDur = acDurs.reduce((s, x) => s + x, 0);
  const d = songs[songs.length - 1];
  return {
    songs,
    acRootAccuracy:
      ac.reduce((s, x, i) => s + x.rootAccuracy * acDurs[i], 0) / totalDur,
    acTriadAccuracy:
      ac.reduce((s, x, i) => s + x.triadAccuracy * acDurs[i], 0) / totalDur,
    acSpuriousSlashSec: ac.reduce((s, x) => s + x.spuriousSlashSec, 0),
    dRootAccuracy: d.rootAccuracy,
    dTriadAccuracy: d.triadAccuracy,
    dSlashAccuracy: d.slashAccuracy,
    dKeyCorrect: d.detectedKey === d.trueKey,
  };
}

// ---------------------------------------------------------------------------
// 実曲の感度チェック（正解境界 ±0.3 秒シフト、hybrid のみ）
// ---------------------------------------------------------------------------

export const REAL_AUDIO_PATH = join(
  homedir(),
  "workspace/user/files/86BE6853-8271-4E56-B2EA-7B93A85D6B14-Corinne Bailey Rae 03. Put Your Records On.mp3",
);
export const REAL_TRUTH_PATH = join(
  MEASUREMENTS_DIR,
  "real/put-your-records-on/truth.json",
);

export interface HybridSensitivityEntry {
  shiftSec: number;
  rootAccuracy: number;
  triadAccuracy: number;
  coreAccuracy: number | null;
}

export interface HybridRealResult {
  base: {
    detectedKey: string;
    detectedBpm: number | null;
    rootAccuracy: number;
    triadAccuracy: number;
    coreAccuracy: number | null;
    ncShare: number;
    confusions: RealSongMeasurement["confusions"];
  };
  sensitivity: HybridSensitivityEntry[];
}

/** 正解の全境界を一律にずらす（先頭セグメントの開始だけ 0 未満にしない） */
export function shiftTruth(truth: RealTruth, deltaSec: number): RealTruth {
  return {
    ...truth,
    segments: truth.segments.map((s) => ({
      ...s,
      startSec: Math.max(0, s.startSec + deltaSec),
      endSec: s.endSec + deltaSec,
    })),
  };
}

export async function runHybridRealSensitivity(): Promise<HybridRealResult | null> {
  if (!existsSync(REAL_AUDIO_PATH) || !existsSync(REAL_TRUTH_PATH)) return null;
  const truth = parseTruthJson(
    JSON.parse(readFileSync(REAL_TRUTH_PATH, "utf-8")),
    "put-your-records-on",
  );
  const audio = loadAudioFile(REAL_AUDIO_PATH);
  const audioDur = audio.samples.length / audio.sampleRate;
  if (truth.durationSec > audioDur) truth.durationSec = audioDur;

  const result = await analyzeAudio(
    audio.samples,
    audio.sampleRate,
    "put-your-records-on.mp3",
    undefined,
    HYBRID_OPTIONS,
  );
  const base = measureRealSong(truth, result, "hybrid");
  const sensitivity: HybridSensitivityEntry[] = [];
  for (const shiftSec of [-0.3, 0, 0.3]) {
    const m = measureRealSong(shiftTruth(truth, shiftSec), result, "hybrid");
    sensitivity.push({
      shiftSec,
      rootAccuracy: m.rootAccuracy,
      triadAccuracy: m.triadAccuracy,
      coreAccuracy: m.coreAccuracy,
    });
  }
  return {
    base: {
      detectedKey: base.detectedKey,
      detectedBpm: base.detectedBpm,
      rootAccuracy: base.rootAccuracy,
      triadAccuracy: base.triadAccuracy,
      coreAccuracy: base.coreAccuracy,
      ncShare: base.ncShare,
      confusions: base.confusions,
    },
    sensitivity,
  };
}

export interface HybridMeasurementResult {
  synthetic: HybridSyntheticResult;
  real: HybridRealResult | null;
}

export async function runHybridMeasurement(): Promise<HybridMeasurementResult> {
  mkdirSync(MEASUREMENTS_DIR, { recursive: true });
  const result: HybridMeasurementResult = {
    synthetic: await runHybridSynthetic(),
    real: await runHybridRealSensitivity(),
  };
  writeFileSync(
    join(MEASUREMENTS_DIR, "hybrid-results.json"),
    JSON.stringify(result, null, 2) + "\n",
    "utf-8",
  );
  return result;
}

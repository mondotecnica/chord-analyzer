/**
 * Phase 1.5b 条件分岐（split-conditional）の測定ハーネス。
 *
 * 分業（split）の後段で、崩壊シグネチャのあるセグメントだけルートも
 * 上帯域で決め直す構成（src/analysis/conditionalBand.ts）を測る:
 *
 * 1. 合成回帰: Songs A–D に split-conditional を適用し、split
 *    （scripts/measureHybrid.ts）と同じ手順（WAV 往復あり）で測定する。
 *    あわせて split とのセグメント比較で「発火したセグメント」
 *    （ルートが変わったセグメント）の件数・秒数・正誤を数える。
 *    対照値（PHASE1_5_HYBRID.md / PHASE1_UPPERBAND.md）:
 *    - split: A–C ルート 95.4% / 三和音 89.2%、Song D ルート 26.7%
 *    - unified-260（現在の既定）: Song D ルート 87.2% / 分数 87.2%
 * 2. 実曲: Put Your Records On を hybrid と並べて測定し、発火箇所
 *    （時刻・変更前後・正解ラベル）を洗い出す。実曲はしきい値調整には
 *    使わず、検証専用（PHASE1_5B_CONDITIONAL.md）。
 *
 * 出力: measurements/conditional-results.json
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeAudio, type AnalyzeOptions } from "../src/analysis/analyze";
import { parseChordName } from "../src/analysis/bassCorrection";
import {
  loadAudioFile,
  measureRealSong,
  parseTruthChord,
  parseTruthJson,
  type RealSongMeasurement,
} from "./measureReal";
import { HYBRID_OPTIONS, REAL_AUDIO_PATH, REAL_TRUTH_PATH } from "./measureHybrid";
import { measureSong, parseChord } from "./measureSynthetic";
import { measureSlash } from "./measurePhase1Step2";
import { SONGS, SLASH_SONGS, synthSong, type SongSpec } from "./synth";
import { readWav16, writeWav16 } from "./wav";

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TEST_AUDIO_DIR = join(PROJECT_ROOT, "test-audio");
const MEASUREMENTS_DIR = join(PROJECT_ROOT, "measurements");
const SAMPLE_RATE = 44100;

/** 条件分岐の解析オプション。measureReal.ts の REAL_CONFIGS と同一 */
export const CONDITIONAL_OPTIONS: AnalyzeOptions = {
  bassCorrection: true,
  bandStrategy: "split-conditional",
};

export interface FiredSegment {
  startSec: number;
  endSec: number;
  /** split でのコード → 条件分岐でのコード */
  fromChord: string;
  toChord: string;
  /** その時刻の正解コード（ラベル用。実曲は再構成正解） */
  truthChord: string | null;
  /** 発火後のルートが正解ルートと一致するか */
  toRootCorrect: boolean | null;
}

/**
 * split と split-conditional のセグメント列を突き合わせ、ルートが
 * 変わったセグメント（＝条件分岐が発火したセグメント）を抽出する。
 * 両者はフレーム判定・セグメンテーション・ベース補正まで同一手順の
 * ため、セグメント境界と件数は一致する前提で index で対応付ける。
 */
export function diffFiredSegments(
  baseSegments: { start: number; end: number; chord: string }[],
  condSegments: { start: number; end: number; chord: string }[],
  truthRootAt: (mid: number) => { chord: string; root: number | null } | null,
): FiredSegment[] {
  const fired: FiredSegment[] = [];
  const n = Math.min(baseSegments.length, condSegments.length);
  for (let i = 0; i < n; i++) {
    const b = baseSegments[i];
    const c = condSegments[i];
    const bp = parseChord(b.chord);
    const cp = parseChord(c.chord);
    if (!bp || !cp || bp.root === cp.root) continue;
    const mid = (c.start + c.end) / 2;
    const t = truthRootAt(mid);
    fired.push({
      startSec: Number(c.start.toFixed(2)),
      endSec: Number(c.end.toFixed(2)),
      fromChord: b.chord,
      toChord: c.chord,
      truthChord: t?.chord ?? null,
      toRootCorrect: t?.root != null ? t.root === cp.root : null,
    });
  }
  return fired;
}

export interface ConditionalSongResult {
  songId: string;
  title: string;
  trueKey: string;
  detectedKey: string;
  rootAccuracy: number;
  triadAccuracy: number;
  ncShare: number;
  slashAccuracy: number;
  spuriousSlashSec: number;
  firedCount: number;
  firedSec: number;
  fired: FiredSegment[];
  topConfusions: { gt: string; det: string; sec: number }[];
}

export interface ConditionalSyntheticResult {
  songs: ConditionalSongResult[];
  acRootAccuracy: number;
  acTriadAccuracy: number;
  acSpuriousSlashSec: number;
  dRootAccuracy: number;
  dTriadAccuracy: number;
  dSlashAccuracy: number;
  dKeyCorrect: boolean;
}

export async function runConditionalSynthetic(): Promise<ConditionalSyntheticResult> {
  mkdirSync(TEST_AUDIO_DIR, { recursive: true });
  const specs: SongSpec[] = [...SONGS, ...SLASH_SONGS];
  const songs: ConditionalSongResult[] = [];
  const durations: number[] = [];
  for (const spec of specs) {
    const { samples, truth } = synthSong(spec, SAMPLE_RATE);
    const wavPath = join(TEST_AUDIO_DIR, `${spec.id}.wav`);
    writeWav16(wavPath, samples, SAMPLE_RATE);
    const wav = readWav16(wavPath);
    const baseResult = await analyzeAudio(
      wav.samples,
      wav.sampleRate,
      `${spec.id}.wav`,
      undefined,
      HYBRID_OPTIONS,
    );
    const result = await analyzeAudio(
      wav.samples,
      wav.sampleRate,
      `${spec.id}.wav`,
      undefined,
      CONDITIONAL_OPTIONS,
    );
    const m = measureSong(truth, result);
    const slash = measureSlash(truth, result);
    const fired = diffFiredSegments(baseResult.segments, result.segments, (mid) => {
      const s = truth.segments.find((x) => mid >= x.startSec && mid < x.endSec);
      const p = s ? parseChordName(s.chord) : null;
      return s ? { chord: s.chord, root: p?.root ?? null } : null;
    });
    durations.push(truth.durationSec);
    songs.push({
      songId: spec.id,
      title: truth.title,
      trueKey: truth.key,
      detectedKey: m.detectedKey,
      rootAccuracy: m.rootAccuracy,
      triadAccuracy: m.triadAccuracy,
      ncShare: m.ncShare,
      slashAccuracy: slash.slashAccuracy,
      spuriousSlashSec: slash.spuriousSlashSec,
      firedCount: fired.length,
      firedSec: fired.reduce((s, f) => s + (f.endSec - f.startSec), 0),
      fired,
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
// 実曲（検証専用。しきい値調整には使わない）
// ---------------------------------------------------------------------------

export interface ConditionalRealResult {
  hybrid: {
    rootAccuracy: number;
    triadAccuracy: number;
    coreAccuracy: number | null;
    confusions: RealSongMeasurement["confusions"];
  };
  conditional: {
    detectedKey: string;
    detectedBpm: number | null;
    rootAccuracy: number;
    triadAccuracy: number;
    coreAccuracy: number | null;
    ncShare: number;
    confusions: RealSongMeasurement["confusions"];
  };
  firedCount: number;
  firedSec: number;
  fired: FiredSegment[];
}

export async function runConditionalReal(): Promise<ConditionalRealResult | null> {
  if (!existsSync(REAL_AUDIO_PATH) || !existsSync(REAL_TRUTH_PATH)) return null;
  const truth = parseTruthJson(
    JSON.parse(readFileSync(REAL_TRUTH_PATH, "utf-8")),
    "put-your-records-on",
  );
  const audio = loadAudioFile(REAL_AUDIO_PATH);
  const audioDur = audio.samples.length / audio.sampleRate;
  if (truth.durationSec > audioDur) truth.durationSec = audioDur;

  const baseResult = await analyzeAudio(
    audio.samples,
    audio.sampleRate,
    "put-your-records-on.mp3",
    undefined,
    HYBRID_OPTIONS,
  );
  const result = await analyzeAudio(
    audio.samples,
    audio.sampleRate,
    "put-your-records-on.mp3",
    undefined,
    CONDITIONAL_OPTIONS,
  );
  const hybrid = measureRealSong(truth, baseResult, "hybrid");
  const conditional = measureRealSong(truth, result, "conditional");
  const fired = diffFiredSegments(baseResult.segments, result.segments, (mid) => {
    const s = truth.segments.find((x) => mid >= x.startSec && mid < x.endSec);
    if (!s) return null;
    const core = parseTruthChord(s.chord);
    return { chord: s.chord, root: core?.root ?? null };
  });
  return {
    hybrid: {
      rootAccuracy: hybrid.rootAccuracy,
      triadAccuracy: hybrid.triadAccuracy,
      coreAccuracy: hybrid.coreAccuracy,
      confusions: hybrid.confusions,
    },
    conditional: {
      detectedKey: conditional.detectedKey,
      detectedBpm: conditional.detectedBpm,
      rootAccuracy: conditional.rootAccuracy,
      triadAccuracy: conditional.triadAccuracy,
      coreAccuracy: conditional.coreAccuracy,
      ncShare: conditional.ncShare,
      confusions: conditional.confusions,
    },
    firedCount: fired.length,
    firedSec: fired.reduce((s, f) => s + (f.endSec - f.startSec), 0),
    fired,
  };
}

export interface ConditionalMeasurementResult {
  synthetic: ConditionalSyntheticResult;
  real: ConditionalRealResult | null;
}

export async function runConditionalMeasurement(): Promise<ConditionalMeasurementResult> {
  mkdirSync(MEASUREMENTS_DIR, { recursive: true });
  const result: ConditionalMeasurementResult = {
    synthetic: await runConditionalSynthetic(),
    real: await runConditionalReal(),
  };
  writeFileSync(
    join(MEASUREMENTS_DIR, "conditional-results.json"),
    JSON.stringify(result, null, 2) + "\n",
    "utf-8",
  );
  return result;
}

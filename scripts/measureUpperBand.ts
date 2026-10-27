/**
 * 上帯域クロマ対策の測定ハーネス（Phase 1 Step 2 のフォローアップ）。
 *
 * 背景: Song D（分数コード）では、ベースが構成音を強く鳴らすと全帯域クロマが
 * 引っ張られ、ルート検出自体が崩れた（ルート正解率 26.7%、
 * measurements/PHASE1_STEP2.md）。対策として「コード判定に使うクロマだけ
 * ベース帯域を弱めた上帯域クロマにする」変種を、対照（従来動作）と比較する。
 *
 * - 全バリアントでベース補正は ON（Step 1 の本線動作）。
 * - キー推定・ベース補正のモード決め直しは常に全帯域クロマ（analyze.ts の設計）。
 * - 履歴測定（Phase 0 / Step 1 / Step 2）は chordBand: null を明示固定して
 *   あるため、この既定値の検討で書き換わることはない。
 *
 * 出力: measurements/upperband-results.json
 * （レポート PHASE1_UPPERBAND.md はこの JSON の数字をもとに作成する）
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeAudio } from "../src/analysis/analyze";
import type { ChromaBandOptions } from "../src/dsp/chroma";
import { measureSong, type SongMeasurement } from "./measureSynthetic";
import { measureSlash, type SlashMetrics } from "./measurePhase1Step2";
import { SONGS, SLASH_SONGS, synthSong, type SongSpec } from "./synth";
import { readWav16, writeWav16 } from "./wav";

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TEST_AUDIO_DIR = join(PROJECT_ROOT, "test-audio");
const MEASUREMENTS_DIR = join(PROJECT_ROOT, "measurements");
const SAMPLE_RATE = 44100;

export interface BandVariant {
  id: string;
  label: string;
  band: ChromaBandOptions | null;
}

/** 比較するバリアント（off = 対照: 全帯域クロマ、Step 1/2 の従来動作） */
export const BAND_VARIANTS: BandVariant[] = [
  { id: "off", label: "対照（全帯域）", band: null },
  { id: "cut260", label: "ハードカット 260Hz（×0）", band: { cutoffHz: 260, belowWeight: 0 } },
  { id: "cut220", label: "ハードカット 220Hz（×0）", band: { cutoffHz: 220, belowWeight: 0 } },
  { id: "cut200", label: "ハードカット 200Hz（×0）", band: { cutoffHz: 200, belowWeight: 0 } },
  { id: "soft260-025", label: "減衰 260Hz ×0.25", band: { cutoffHz: 260, belowWeight: 0.25 } },
  { id: "soft260-010", label: "減衰 260Hz ×0.10", band: { cutoffHz: 260, belowWeight: 0.1 } },
];

export interface VariantSongResult {
  songId: string;
  title: string;
  trueKey: string;
  detectedKey: string;
  trueBpm: number;
  detectedBpm: number | null;
  rootAccuracy: number;
  triadAccuracy: number;
  ncShare: number;
  rootWrongSec: number;
  modeFlipSec: number;
  slashAccuracy: number;
  slashCorrectSec: number;
  slashExpectedSec: number;
  spuriousSlashSec: number;
  topConfusions: { gt: string; det: string; sec: number }[];
}

export interface VariantResult {
  variant: BandVariant;
  songs: VariantSongResult[];
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

export interface UpperBandResult {
  variants: VariantResult[];
  selection: SelectionOutcome;
}

export interface SelectionOutcome {
  winnerId: string | null;
  evaluations: {
    variantId: string;
    pass: boolean;
    reasons: string[];
  }[];
}

/** Song D の目標（26.7% から十分に上がることの目安） */
export const D_ROOT_TARGET = 0.5;
/** A–C の許容低下幅（対照比、ポイント） */
export const AC_TOLERANCE = 0.01;

function toSongResult(
  spec: SongSpec,
  measurement: SongMeasurement,
  slash: SlashMetrics,
): VariantSongResult {
  return {
    songId: spec.id,
    title: measurement.truth.title,
    trueKey: measurement.truth.key,
    detectedKey: measurement.detectedKey,
    trueBpm: measurement.truth.bpm,
    detectedBpm: measurement.detectedBpm,
    rootAccuracy: measurement.rootAccuracy,
    triadAccuracy: measurement.triadAccuracy,
    ncShare: measurement.ncShare,
    rootWrongSec: measurement.rootWrongSec,
    modeFlipSec: measurement.modeFlipSec,
    slashAccuracy: slash.slashAccuracy,
    slashCorrectSec: slash.slashCorrectSec,
    slashExpectedSec: slash.slashExpectedSec,
    spuriousSlashSec: slash.spuriousSlashSec,
    topConfusions: measurement.confusions.slice(0, 3),
  };
}

/**
 * 受け入れ基準によるバリアント選定（純粋関数）。
 * 対照（off）を基準に:
 * - Song D ルートが D_ROOT_TARGET 以上
 * - A–C 合計ルート／三和音が対照 − AC_TOLERANCE 以内
 * - A–C で誤った分数表示が 0（浮動小数の誤差 5ms まで許容）
 * 通過した中で Song D ルート最良 → A–C ルート → A–C 三和音の順で選ぶ。
 */
export function selectWinner(variants: VariantResult[]): SelectionOutcome {
  const control = variants.find((v) => v.variant.id === "off");
  if (!control) throw new Error("対照バリアント（off）がありません");
  const evaluations: SelectionOutcome["evaluations"] = [];
  const passing: VariantResult[] = [];
  for (const v of variants) {
    if (v.variant.id === "off") continue;
    const reasons: string[] = [];
    if (v.dRootAccuracy < D_ROOT_TARGET) {
      reasons.push(
        `Song D ルート ${(v.dRootAccuracy * 100).toFixed(1)}% < 目標 ${(D_ROOT_TARGET * 100).toFixed(0)}%`,
      );
    }
    if (v.acRootAccuracy < control.acRootAccuracy - AC_TOLERANCE) {
      reasons.push(
        `A–C ルート ${(v.acRootAccuracy * 100).toFixed(1)}% が対照 ${(control.acRootAccuracy * 100).toFixed(1)}% から 1pt 超低下`,
      );
    }
    if (v.acTriadAccuracy < control.acTriadAccuracy - AC_TOLERANCE) {
      reasons.push(
        `A–C 三和音 ${(v.acTriadAccuracy * 100).toFixed(1)}% が対照 ${(control.acTriadAccuracy * 100).toFixed(1)}% から 1pt 超低下`,
      );
    }
    if (v.acSpuriousSlashSec > 0.005) {
      reasons.push(`A–C で誤った分数表示 ${v.acSpuriousSlashSec.toFixed(2)}秒`);
    }
    const pass = reasons.length === 0;
    evaluations.push({ variantId: v.variant.id, pass, reasons });
    if (pass) passing.push(v);
  }
  passing.sort(
    (a, b) =>
      b.dRootAccuracy - a.dRootAccuracy ||
      b.acRootAccuracy - a.acRootAccuracy ||
      b.acTriadAccuracy - a.acTriadAccuracy,
  );
  return { winnerId: passing[0]?.variant.id ?? null, evaluations };
}

export async function runUpperBandMeasurement(): Promise<UpperBandResult> {
  mkdirSync(TEST_AUDIO_DIR, { recursive: true });
  mkdirSync(MEASUREMENTS_DIR, { recursive: true });

  const specs: SongSpec[] = [...SONGS, ...SLASH_SONGS];
  // 曲ごとに一度だけ合成し、全バリアントで使い回す
  const prepared = specs.map((spec) => {
    const { samples, truth } = synthSong(spec, SAMPLE_RATE);
    const wavPath = join(TEST_AUDIO_DIR, `${spec.id}.wav`);
    writeWav16(wavPath, samples, SAMPLE_RATE);
    const wav = readWav16(wavPath);
    return { spec, truth, samples: wav.samples, sampleRate: wav.sampleRate };
  });

  const variants: VariantResult[] = [];
  for (const variant of BAND_VARIANTS) {
    const songs: VariantSongResult[] = [];
    for (const p of prepared) {
      const result = await analyzeAudio(
        p.samples,
        p.sampleRate,
        `${p.spec.id}.wav`,
        undefined,
        // バリアントは unified 前提の比較。戦略も明示固定する（既定は split に変更済み）
        { bassCorrection: true, chordBand: variant.band, bandStrategy: "unified" },
      );
      const measurement = measureSong(p.truth, result);
      const slash = measureSlash(p.truth, result);
      songs.push(toSongResult(p.spec, measurement, slash));
    }
    const ac = songs.slice(0, SONGS.length);
    const durs = prepared
      .slice(0, SONGS.length)
      .map((p) => p.truth.durationSec);
    const totalDur = durs.reduce((s, x) => s + x, 0);
    const d = songs[songs.length - 1];
    variants.push({
      variant,
      songs,
      acRootAccuracy:
        ac.reduce((s, x, i) => s + x.rootAccuracy * durs[i], 0) / totalDur,
      acTriadAccuracy:
        ac.reduce((s, x, i) => s + x.triadAccuracy * durs[i], 0) / totalDur,
      acSpuriousSlashSec: ac.reduce((s, x) => s + x.spuriousSlashSec, 0),
      dRootAccuracy: d.rootAccuracy,
      dTriadAccuracy: d.triadAccuracy,
      dSlashAccuracy: d.slashAccuracy,
      dKeyCorrect: d.detectedKey === d.trueKey,
    });
  }

  const result: UpperBandResult = {
    variants,
    selection: selectWinner(variants),
  };
  writeFileSync(
    join(MEASUREMENTS_DIR, "upperband-results.json"),
    JSON.stringify(result, null, 2) + "\n",
    "utf-8",
  );
  return result;
}

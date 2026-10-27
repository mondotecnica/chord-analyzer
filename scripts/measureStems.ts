/**
 * Phase 2 プロトタイプ測定ハーネス — ステム入力の合成（アプリ本体は無変更）。
 *
 * 目的: 「ステム分離した入力で Phase 1 の病気が治るか」を、Phase 1 と
 * 同じ正解・同じ指標（scripts/measureReal.ts の measureRealSong）で測る。
 * 分離は外部（HTDemucs、tools/phase2-venv）で済ませ、ステム WAV が
 * stem-work/<song>/ 以下にある前提で動く。ステムが無い曲はスキップする
 * （npm test を壊さないため）。
 *
 * "stems" 設定の構成（analyze.ts の既定 split 経路とモジュール対応）:
 *   analyzeAudio（split）の処理          stems プロトタイプでの入力
 *   ----------------------------------  --------------------------------
 *   フレーム判定の全帯域クロマ           other ステムの全帯域クロマ
 *   ベース補正の低域分布（bassFrames）   bass ステムから計算した低域分布
 *   ベース補正のスコア比較用クロマ       other ステムの全帯域クロマ
 *   モード決め直しの上帯域クロマ         other ステムの上帯域クロマ（260Hz）
 *   キー推定・テンポ推定                 混合音（Phase 1 と比較条件を揃える）
 *   vocals / drums ステム               コード判定には一切使わない
 *
 * つまり差し替えは「クロマと低域分布の出所」だけで、判定の中核
 * （estimateChordFrames / framesToSegments / applyBassCorrection /
 * applyUpperBandMode）は既存モジュールをそのまま使う。
 * 計画の詳細は PHASE2_PLAN.md を参照。
 *
 * ステム合成の本体（prepareStemChromas / analyzeStemsWithStrategy /
 * 帯域戦略の named configs）はアプリ本体の src/analysis/analyzeStems.ts
 * に移設済みで、本ハーネスはそれをそのまま使う（アプリの高精度モードと
 * 測定が同一実装を共有する）。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeAudio } from "../src/analysis/analyze";
import {
  analyzeStemsWithStrategy,
  prepareStemChromas,
  STEM_BAND_CONFIGS,
  type StemBandStrategy,
} from "../src/analysis/analyzeStems";
import { aggregateBassDistribution } from "../src/dsp/bass";
import { computeChromagram } from "../src/dsp/chroma";
import { NO_CHORD } from "../src/lib/notes";
import type { AnalysisResult } from "../src/types";
import {
  loadAudioFile,
  measureRealSong,
  parseTruthChord,
  parseTruthJson,
  type RealSongMeasurement,
  type RealTruth,
} from "./measureReal";
import { shiftTruth } from "./measureHybrid";
import { parseChord } from "./measureSynthetic";

const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));
const PHASE2_DIR = join(PROJECT_ROOT, "measurements", "phase2");
const STEM_WORK_DIR = join(PROJECT_ROOT, "stem-work");

// ---------------------------------------------------------------------------
// ステム合成による解析（帯域戦略 A/B の named configs）
// ---------------------------------------------------------------------------
// 本体は src/analysis/analyzeStems.ts（アプリと共有）。ここでは
// 従来の import 経路を保つため再エクスポートする。

export {
  analyzeStemsWithStrategy,
  analyzeWithStems,
  prepareStemChromas,
  STEM_BAND_CONFIGS,
  type StemBandConfig,
  type StemBandStrategy,
  type StemChromas,
} from "../src/analysis/analyzeStems";

// ---------------------------------------------------------------------------
// 分離品質の sanity（ステム別エネルギーと bass の追跡可能性）
// ---------------------------------------------------------------------------

export interface StemSanity {
  /** ステムごとの RMS（混合音 RMS = 1 とした相対値も併記） */
  rms: Record<string, number>;
  rmsRelativeToMix: Record<string, number>;
  /** 1 秒窓ごとの低域分布トップシェアの中央値（bass ステム／混合音） */
  bassTopShareMedian: number;
  mixTopShareMedian: number;
}

function rmsOf(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / Math.max(1, samples.length));
}

/** 低域分布のトップシェア中央値（1 秒窓、無音に近い窓は除外） */
function bassTopShareMedian(samples: Float32Array, sampleRate: number): number {
  const chroma = computeChromagram(samples, sampleRate);
  const framesPerWindow = Math.max(1, Math.round(1 / chroma.frameDuration));
  const shares: number[] = [];
  for (let start = 0; start < chroma.bassFrames.length; start += framesPerWindow) {
    const dist = aggregateBassDistribution(
      chroma.bassFrames,
      start,
      start + framesPerWindow,
    );
    if (dist.total <= 0) continue;
    // 無音に近い窓（エネルギーが全体中央値の 1/20 未満）は除外
    shares.push(dist.topShare);
  }
  if (shares.length === 0) return 0;
  shares.sort((a, b) => a - b);
  return shares[Math.floor(shares.length / 2)];
}

// ---------------------------------------------------------------------------
// 曲ごとの測定
// ---------------------------------------------------------------------------

export interface StemSongSpec {
  slug: string;
  title: string;
  mixPath: string;
  truthPath: string;
  /** stem-work/<slug>/ 以下で bass.wav 等を再帰探索する */
  stemRoot: string;
}

export const STEM_SONGS: StemSongSpec[] = [
  {
    slug: "put-your-records-on",
    title: "Put Your Records On — Corinne Bailey Rae",
    mixPath: join(
      homedir(),
      "workspace/user/files/86BE6853-8271-4E56-B2EA-7B93A85D6B14-Corinne Bailey Rae 03. Put Your Records On.mp3",
    ),
    truthPath: join(PROJECT_ROOT, "measurements/real/put-your-records-on/truth.json"),
    stemRoot: join(STEM_WORK_DIR, "put-your-records-on"),
  },
  {
    slug: "everything",
    title: "Everything — MISIA",
    mixPath: join(
      homedir(),
      "workspace/user/files/3187FA6A-1A05-4EDC-9631-64173C8D9FB8-MISIA - Everything （Official HD Music Video）.mp3",
    ),
    truthPath: join(PROJECT_ROOT, "measurements/real/everything/truth.json"),
    stemRoot: join(STEM_WORK_DIR, "everything"),
  },
  {
    slug: "a-hard-days-night",
    title: "A Hard Day's Night — The Beatles",
    mixPath: join(
      homedir(),
      "workspace/user/files/A_Hard_Day_s_Night__Remastered_2009.mp3",
    ),
    truthPath: join(PROJECT_ROOT, "measurements/real/a-hard-days-night/truth.json"),
    stemRoot: join(STEM_WORK_DIR, "a-hard-days-night"),
  },
  {
    slug: "song-d",
    title: "Song D — 合成分数コード（C/E–F/A–G/B–Am/E）",
    mixPath: join(PROJECT_ROOT, "test-audio/song-d.wav"),
    truthPath: join(PROJECT_ROOT, "test-audio/song-d.groundtruth.json"),
    stemRoot: join(STEM_WORK_DIR, "song-d"),
  },
];

/** stem-work/<slug>/ 以下で bass.wav 等を再帰探索する（アプリ経路テストと共有） */
export function findStemWav(stemRoot: string, stemName: string): string | null {
  if (!existsSync(stemRoot)) return null;
  const stack = [stemRoot];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else if (entry.name === `${stemName}.wav`) return path;
    }
  }
  return null;
}

export interface StemVariantResult {
  strategy: StemBandStrategy;
  measurement: RealSongMeasurement;
  slash: SlashStats | null;
}

export interface StemSongResult {
  slug: string;
  title: string;
  sanity: StemSanity;
  /** s-split（現行プロトタイプ）の測定。STEMS_PROTOTYPE.md の "stems" 行 */
  stems: RealSongMeasurement;
  /** 帯域戦略 A/B（STEM_BAND_AB.md）の全バリアント測定 */
  variants: StemVariantResult[];
  /** 同一実行で測った混合音の現在既定（split）— 記録値との照合用 */
  mixDefault: RealSongMeasurement;
  sensitivity: { shiftSec: number; rootAccuracy: number; triadAccuracy: number; coreAccuracy: number | null }[];
  /** 正解にベース≠ルートの区間がある曲のみ（Phase 1 の分数小節分析の簡略版） */
  slash: { stems: SlashStats; mixDefault: SlashStats } | null;
}

// ---------------------------------------------------------------------------
// 分数コード区間の読み（正解のベースがルートと異なる区間だけを切り出す）
// ---------------------------------------------------------------------------

export interface SlashStats {
  segmentCount: number;
  totalSec: number;
  /** 検出ルートが正解ルートと一致した時間比（N.C. は不正解として数える） */
  rootAccuracy: number;
  /** 検出セグメントの bassPc が正解ベースと一致した時間比 */
  bassAccuracy: number;
  /** ルートとベースが両方一致した時間比（分数として完全正解） */
  fullAccuracy: number;
}

const NOTE_BASE_PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

function noteNameToPc(name: string): number | null {
  const m = name.replace("♭", "b").replace("♯", "#").match(/^([A-G])(#|b)?$/);
  if (!m) return null;
  let pc = NOTE_BASE_PC[m[1]];
  if (m[2] === "#") pc += 1;
  if (m[2] === "b") pc -= 1;
  return ((pc % 12) + 12) % 12;
}

export function computeSlashStats(truth: RealTruth, result: AnalysisResult): SlashStats | null {
  const STEP = 0.01;
  let total = 0;
  let rootOk = 0;
  let bassOk = 0;
  let fullOk = 0;
  let segCount = 0;
  const segs = result.segments;
  for (const gtSeg of truth.segments) {
    const gtP = parseTruthChord(gtSeg.chord);
    if (!gtP || !gtSeg.bass) continue;
    const bassPc = noteNameToPc(gtSeg.bass);
    if (bassPc === null || bassPc === gtP.root) continue;
    segCount++;
    let segIdx = 0;
    const end = Math.min(gtSeg.endSec, result.duration);
    for (let t = gtSeg.startSec; t < end; t += STEP) {
      const mid = t + STEP / 2;
      while (segIdx < segs.length - 1 && mid >= segs[segIdx].end) segIdx++;
      const det =
        segs[segIdx] && mid >= segs[segIdx].start && mid < segs[segIdx].end
          ? segs[segIdx]
          : null;
      total += STEP;
      if (!det || det.chord === NO_CHORD) continue;
      const detP = parseChord(det.chord);
      if (!detP) continue;
      const rOk = detP.root === gtP.root;
      const bOk = det.bassPc !== undefined && det.bassPc === bassPc;
      if (rOk) rootOk += STEP;
      if (bOk) bassOk += STEP;
      if (rOk && bOk) fullOk += STEP;
    }
  }
  if (segCount === 0 || total === 0) return null;
  return {
    segmentCount: segCount,
    totalSec: total,
    rootAccuracy: rootOk / total,
    bassAccuracy: bassOk / total,
    fullAccuracy: fullOk / total,
  };
}

export async function runStemSong(spec: StemSongSpec): Promise<StemSongResult | null> {
  const stemPaths: Record<string, string> = {};
  for (const name of ["drums", "bass", "other", "vocals"]) {
    const p = findStemWav(spec.stemRoot, name);
    if (!p) return null; // 未分離の曲はスキップ
    stemPaths[name] = p;
  }
  if (!existsSync(spec.mixPath) || !existsSync(spec.truthPath)) return null;

  const truth: RealTruth = parseTruthJson(
    JSON.parse(readFileSync(spec.truthPath, "utf-8")),
    spec.slug,
  );
  const mix = loadAudioFile(spec.mixPath);
  const stems: Record<string, ReturnType<typeof loadAudioFile>> = {};
  for (const name of Object.keys(stemPaths)) {
    stems[name] = loadAudioFile(stemPaths[name]);
  }
  const sr = mix.sampleRate;
  const audioDur = mix.samples.length / sr;
  if (truth.durationSec > audioDur) truth.durationSec = audioDur;

  const mixRms = rmsOf(mix.samples);
  const sanity: StemSanity = {
    rms: {},
    rmsRelativeToMix: {},
    bassTopShareMedian: bassTopShareMedian(stems.bass.samples, sr),
    mixTopShareMedian: bassTopShareMedian(mix.samples, sr),
  };
  for (const name of Object.keys(stems)) {
    sanity.rms[name] = rmsOf(stems[name].samples);
    sanity.rmsRelativeToMix[name] = mixRms > 0 ? sanity.rms[name] / mixRms : 0;
  }

  // クロマは曲ごとに 1 回だけ計算し、帯域戦略ごとに判定パイプラインを回す
  const chromas = prepareStemChromas(mix.samples, stems.other.samples, stems.bass.samples, sr);
  const variantResults = new Map<StemBandStrategy, AnalysisResult>();
  for (const config of STEM_BAND_CONFIGS) {
    variantResults.set(
      config.id,
      analyzeStemsWithStrategy(chromas, sr, `${spec.slug} (stems ${config.id})`, config.id),
    );
  }
  const variants: StemVariantResult[] = STEM_BAND_CONFIGS.map((config) => {
    const result = variantResults.get(config.id)!;
    return {
      strategy: config.id,
      measurement: measureRealSong(truth, result, `stems-${config.id}`),
      slash: computeSlashStats(truth, result),
    };
  });

  const stemResult = variantResults.get("s-split")!;
  const stemsMeasurement = measureRealSong(truth, stemResult, "stems");

  const mixResult = await analyzeAudio(mix.samples, sr, spec.slug);
  const mixMeasurement = measureRealSong(truth, mixResult, "default");

  const sensitivity = [-0.3, 0, 0.3].map((shiftSec) => {
    const m = measureRealSong(shiftTruth(truth, shiftSec), stemResult, "stems");
    return {
      shiftSec,
      rootAccuracy: m.rootAccuracy,
      triadAccuracy: m.triadAccuracy,
      coreAccuracy: m.coreAccuracy,
    };
  });

  const slashStems = computeSlashStats(truth, stemResult);
  const slashMix = computeSlashStats(truth, mixResult);
  const slash =
    slashStems && slashMix ? { stems: slashStems, mixDefault: slashMix } : null;

  return {
    slug: spec.slug,
    title: spec.title,
    sanity,
    stems: stemsMeasurement,
    variants,
    mixDefault: mixMeasurement,
    sensitivity,
    slash,
  };
}

// ---------------------------------------------------------------------------
// 帯域戦略 A/B の集計（判定ルールは STEM_BAND_AB.md に事前登録）
// ---------------------------------------------------------------------------

export interface StemBandAggregate {
  strategy: StemBandStrategy;
  /** 実曲ごとの (ルート+三和音+コア)/3 */
  perSongScore: Record<string, number>;
  /** 主基準: 実曲 3 曲の perSongScore の単純平均 */
  meanScore: number;
  /** 実曲 3 曲平均の N.C. 割合（タイブレーカー／品質注記用） */
  meanNcShare: number;
  /** ガードレール: 合成 Song D のルート正解率 */
  songDRoot: number | null;
  /** 実曲 3 曲のうち、その曲の最良（同点含む）だった曲数 */
  bestOrTiedSongs: number;
}

const REAL_SONG_SLUGS = ["put-your-records-on", "everything", "a-hard-days-night"];

export function summarizeStemBandAB(results: StemSongResult[]): StemBandAggregate[] {
  const songScore = (m: RealSongMeasurement) =>
    (m.rootAccuracy + m.triadAccuracy + (m.coreAccuracy ?? 0)) / 3;
  return STEM_BAND_CONFIGS.map((config) => {
    const perSongScore: Record<string, number> = {};
    let ncSum = 0;
    let realCount = 0;
    for (const r of results) {
      if (!REAL_SONG_SLUGS.includes(r.slug)) continue;
      const v = r.variants.find((x) => x.strategy === config.id);
      if (!v) continue;
      perSongScore[r.slug] = songScore(v.measurement);
      ncSum += v.measurement.ncShare;
      realCount++;
    }
    const scores = Object.values(perSongScore);
    let bestOrTiedSongs = 0;
    for (const slug of Object.keys(perSongScore)) {
      const best = Math.max(
        ...STEM_BAND_CONFIGS.map((c) => {
          const r = results.find((x) => x.slug === slug)!;
          const v = r.variants.find((x) => x.strategy === c.id)!;
          return songScore(v.measurement);
        }),
      );
      if (perSongScore[slug] >= best - 1e-9) bestOrTiedSongs++;
    }
    const songD = results.find((r) => r.slug === "song-d");
    const songDV = songD?.variants.find((x) => x.strategy === config.id);
    return {
      strategy: config.id,
      perSongScore,
      meanScore: scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0,
      meanNcShare: realCount > 0 ? ncSum / realCount : 0,
      songDRoot: songDV ? songDV.measurement.rootAccuracy : null,
      bestOrTiedSongs,
    };
  });
}

const pct = (x: number | null) => (x === null ? "—" : `${(x * 100).toFixed(1)}%`);

export function buildStemReport(results: StemSongResult[]): string {
  const lines: string[] = [];
  lines.push("# Phase 2 プロトタイプ測定 — ステム入力（stems 設定）");
  lines.push("");
  lines.push("ハーネス: scripts/measureStems.ts（`npm run measure:stems`）。");
  lines.push("構成: コード判定クロマ = other ステム、ベース低域分布 = bass ステム、");
  lines.push("モード決め直し = other ステムの上帯域（既定 split の適応）。");
  lines.push("キー／テンポは混合音から（Phase 1 と比較条件を揃えるため）。");
  lines.push("正解・指標は Phase 1（measurements/real/*/truth.json、measureRealSong）と同一。");
  lines.push("");
  for (const r of results) {
    lines.push(`## ${r.title}`);
    lines.push("");
    lines.push("### 分離 sanity");
    lines.push("");
    lines.push(
      `- ステム別 RMS（混合音比）: ${Object.entries(r.sanity.rmsRelativeToMix)
        .map(([k, v]) => `${k} ${v.toFixed(2)}`)
        .join(" / ")}`,
    );
    lines.push(
      `- 低域分布トップシェア中央値: bass ステム ${r.sanity.bassTopShareMedian.toFixed(2)} / 混合音 ${r.sanity.mixTopShareMedian.toFixed(2)}`,
    );
    lines.push("");
    lines.push("### 結果（ルート／三和音／コア、時間加重）");
    lines.push("");
    lines.push("| 設定 | ルート | 三和音 | コア | N.C. | キー | BPM |");
    lines.push("| --- | --- | --- | --- | --- | --- | --- |");
    for (const [id, m] of [
      ["stems", r.stems],
      ["default（混合音・現在既定）", r.mixDefault],
    ] as const) {
      lines.push(
        `| ${id} | ${pct(m.rootAccuracy)} | ${pct(m.triadAccuracy)} | ${pct(m.coreAccuracy)} | ${pct(m.ncShare)} | ${m.detectedKey} | ${m.detectedBpm ?? "—"} |`,
      );
    }
    lines.push("");
    lines.push("stems の主な取り違え:");
    for (const c of r.stems.confusions) {
      lines.push(`- ${c.gt} → ${c.det}: ${c.sec.toFixed(1)}秒`);
    }
    lines.push("");
    lines.push(
      `感度（stems、正解 ±0.3 秒）: ${r.sensitivity
        .map((s) => `${s.shiftSec > 0 ? "+" : ""}${s.shiftSec}s → ${pct(s.rootAccuracy)}/${pct(s.triadAccuracy)}/${pct(s.coreAccuracy)}`)
        .join("、")}`,
    );
    lines.push("");
    if (r.slash) {
      lines.push("### 分数コード区間（正解のベース≠ルートの区間）の読み");
      lines.push("");
      lines.push(
        `対象: ${r.slash.stems.segmentCount} セグメント・計 ${r.slash.stems.totalSec.toFixed(1)} 秒（時間加重、N.C. は不正解として数える）`,
      );
      lines.push("");
      lines.push("| 設定 | ルート正解 | ベース一致 | 分数として完全正解 |");
      lines.push("| --- | --- | --- | --- |");
      for (const [id, s] of [
        ["stems", r.slash.stems],
        ["default（混合音・現在既定）", r.slash.mixDefault],
      ] as const) {
        lines.push(
          `| ${id} | ${pct(s.rootAccuracy)} | ${pct(s.bassAccuracy)} | ${pct(s.fullAccuracy)} |`,
        );
      }
      lines.push("");
    }
  }
  return lines.join("\n");
}

export async function runStemMeasurement(): Promise<StemSongResult[]> {
  const results: StemSongResult[] = [];
  for (const spec of STEM_SONGS) {
    const r = await runStemSong(spec);
    if (r) results.push(r);
  }
  if (results.length > 0) {
    mkdirSync(PHASE2_DIR, { recursive: true });
    writeFileSync(
      join(PHASE2_DIR, "stems-results.json"),
      JSON.stringify(results, null, 2) + "\n",
      "utf-8",
    );
    writeFileSync(join(PHASE2_DIR, "STEMS_PROTOTYPE.md"), buildStemReport(results), "utf-8");
    writeFileSync(
      join(PHASE2_DIR, "stem-band-results.json"),
      JSON.stringify(
        { configs: STEM_BAND_CONFIGS, aggregates: summarizeStemBandAB(results) },
        null,
        2,
      ) + "\n",
      "utf-8",
    );
  }
  return results;
}

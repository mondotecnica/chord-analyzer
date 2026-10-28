/**
 * Phase 3.1 測定スイート — 二段判定（第2段＝拡張音検出）の OFF/ON 比較。
 *
 * 進め方は PHASE3_PLAN.md §3.1 の事前登録どおり:
 * - しきい値は合成曲（Song E/F）と Suno フィクスチャで調整し、
 *   実曲 1–3 は「触らずに検証」する（曲ごとのチューニングはしない）。
 * - 既存指標（ルート／三和音／コア）は measureSynthetic / measureReal の
 *   既存関数で測り、定義は変えない。拡張音の指標は extensionScoring.ts。
 * - 第2段 OFF の数値が記録済みベースライン（PHASE1_SUMMARY /
 *   STEM_BAND_AB）を再現することも併せて確認する。
 *
 * 生成物: measurements/phase3/phase3-1-*.json（パート別）。
 * 判定と考察は PHASE3_1_RESULTS.md（手書き）に置く。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeAudio } from "../src/analysis/analyze";
import {
  analyzeStemsWithStrategy,
  prepareStemChromas,
} from "../src/analysis/analyzeStems";
import { fullChordName } from "../src/lib/chordDisplay";
import { NO_CHORD, NOTE_NAMES } from "../src/lib/notes";
import type { AnalysisResult, LocalKeyWindow } from "../src/types";
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
import { findStemWav, STEM_SONGS } from "./measureStems";
import { measureSong, parseChord, type SongMeasurement } from "./measureSynthetic";
import {
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

function outDir(): string {
  mkdirSync(PHASE3_DIR, { recursive: true });
  return PHASE3_DIR;
}

function writeJson(name: string, data: unknown): void {
  writeFileSync(join(outDir(), name), JSON.stringify(data, null, 2) + "\n", "utf-8");
}

// ---------------------------------------------------------------------------
// 合成曲（混合音・既定 split）
// ---------------------------------------------------------------------------

export interface SyntheticEntry {
  songId: string;
  title: string;
  off: SongMeasurement;
  on: SongMeasurement;
  extOff: ExtensionMeasurement;
  extOn: ExtensionMeasurement;
}

export async function runPhase3Synthetic(): Promise<SyntheticEntry[]> {
  mkdirSync(TEST_AUDIO_DIR, { recursive: true });
  const specs: SongSpec[] = [
    ...SONGS,
    ...SLASH_SONGS,
    ...SEVENTH_SONGS,
    ...SECONDARY_DOMINANT_SONGS,
  ];
  const entries: SyntheticEntry[] = [];
  for (const spec of specs) {
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

    const off = await analyzeAudio(wav.samples, wav.sampleRate, `${spec.id}.wav`);
    const on = await analyzeAudio(wav.samples, wav.sampleRate, `${spec.id}.wav`, undefined, {
      extensions: true,
    });
    entries.push({
      songId: spec.id,
      title: spec.title,
      off: measureSong(truth, off),
      on: measureSong(truth, on),
      extOff: measureExtensions(extTruth, truth.durationSec, off),
      extOn: measureExtensions(extTruth, truth.durationSec, on),
    });
  }
  writeJson("phase3-1-synthetic.json", entries);
  return entries;
}

// ---------------------------------------------------------------------------
// 実曲（混合音 既定 / ステム s-conditional）
// ---------------------------------------------------------------------------

export interface RealEntry {
  slug: string;
  title: string;
  /** runPhase3RealMixture で埋まる（ステム側ランナーでは null） */
  mixOff: RealSongMeasurement | null;
  mixOn: RealSongMeasurement | null;
  mixExtOff: ExtensionMeasurement | null;
  mixExtOn: ExtensionMeasurement | null;
  /** runPhase3RealStems で埋まる（混合音側ランナーでは null） */
  stemsOff: RealSongMeasurement | null;
  stemsOn: RealSongMeasurement | null;
  stemsExtOff: ExtensionMeasurement | null;
  stemsExtOn: ExtensionMeasurement | null;
}

function extTruthFromReal(truth: RealTruth): ExtensionTruthSegment[] {
  return truth.segments.flatMap((s) => {
    const label = truthLabelFromFullName(s.chord);
    return label
      ? [{ startSec: s.startSec, endSec: s.endSec, label: s.chord, truth: label }]
      : [];
  });
}

const REAL_SLUGS = ["put-your-records-on", "everything", "a-hard-days-night"];

export async function runPhase3RealMixture(): Promise<RealEntry[]> {
  const entries: RealEntry[] = [];
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

    const off = await analyzeAudio(mix.samples, mix.sampleRate, spec.mixPath);
    const on = await analyzeAudio(mix.samples, mix.sampleRate, spec.mixPath, undefined, {
      extensions: true,
    });
    entries.push({
      slug,
      title: spec.title,
      mixOff: measureRealSong(truth, off, "default"),
      mixOn: measureRealSong(truth, on, "default+ext"),
      mixExtOff: measureExtensions(extTruth, truth.durationSec, off),
      mixExtOn: measureExtensions(extTruth, truth.durationSec, on),
      stemsOff: null,
      stemsOn: null,
      stemsExtOff: null,
      stemsExtOn: null,
    });
  }
  writeJson("phase3-1-real-mixture.json", entries);
  return entries;
}

export async function runPhase3RealStems(): Promise<RealEntry[]> {
  const entries: RealEntry[] = [];
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

    const chromas = prepareStemChromas(mix.samples, other.samples, bass.samples, sr);
    const off = analyzeStemsWithStrategy(chromas, sr, slug, "s-conditional");
    const on = analyzeStemsWithStrategy(chromas, sr, slug, "s-conditional", {
      extensions: true,
    });
    entries.push({
      slug,
      title: spec.title,
      mixOff: null,
      mixOn: null,
      mixExtOff: null,
      mixExtOn: null,
      stemsOff: measureRealSong(truth, off, "stems-s-conditional"),
      stemsOn: measureRealSong(truth, on, "stems-s-conditional+ext"),
      stemsExtOff: measureExtensions(extTruth, truth.durationSec, off),
      stemsExtOn: measureExtensions(extTruth, truth.durationSec, on),
    });
  }
  writeJson("phase3-1-real-stems.json", entries);
  return entries;
}

// ---------------------------------------------------------------------------
// Suno 05 フィクスチャ（PHASE3_PLAN.md §3.1 の回帰テスト）
// ---------------------------------------------------------------------------

const FIXTURE_STEP = 0.05;

/** 窓内で最も時間を占める非 N.C. の完全ラベル（サンプリング集計） */
export function dominantFullLabel(
  result: AnalysisResult,
  lo: number,
  hi: number,
): { label: string; sec: number } | null {
  const tally = new Map<string, number>();
  let segIdx = 0;
  const segs = result.segments;
  for (let t = lo; t < hi; t += FIXTURE_STEP) {
    const mid = t + FIXTURE_STEP / 2;
    while (segIdx < segs.length - 1 && mid >= segs[segIdx].end) segIdx++;
    const det =
      segs[segIdx] && mid >= segs[segIdx].start && mid < segs[segIdx].end
        ? segs[segIdx]
        : null;
    if (!det || det.chord === NO_CHORD) continue;
    const label = fullChordName(det.chord, det.extension);
    tally.set(label, (tally.get(label) ?? 0) + FIXTURE_STEP);
  }
  let best: { label: string; sec: number } | null = null;
  for (const [label, sec] of tally) {
    if (!best || sec > best.sec) best = { label, sec };
  }
  return best;
}

/** 窓内で root=C かつ minor（Cm / Cm7）のラベルが占める秒数 */
export function cmTimeInWindow(result: AnalysisResult, lo: number, hi: number): number {
  let sec = 0;
  let segIdx = 0;
  const segs = result.segments;
  for (let t = lo; t < hi; t += FIXTURE_STEP) {
    const mid = t + FIXTURE_STEP / 2;
    while (segIdx < segs.length - 1 && mid >= segs[segIdx].end) segIdx++;
    const det =
      segs[segIdx] && mid >= segs[segIdx].start && mid < segs[segIdx].end
        ? segs[segIdx]
        : null;
    if (!det) continue;
    const p = parseChord(det.chord);
    if (p && p.root === 0 && p.mode === "minor") sec += FIXTURE_STEP;
  }
  return sec;
}

/** 窓の支配的セグメント（時間最大、N.C. 含む素のセグメント） */
export function dominantSegment(
  result: AnalysisResult,
  lo: number,
  hi: number,
): { chord: string; extension?: string; bassPc?: number; sec: number } | null {
  let best: { chord: string; extension?: string; bassPc?: number; sec: number } | null = null;
  for (const s of result.segments) {
    const overlap = Math.min(s.end, hi) - Math.max(s.start, lo);
    if (overlap <= 0) continue;
    if (!best || overlap > best.sec) {
      best = {
        chord: s.chord,
        ...(s.extension ? { extension: s.extension } : {}),
        ...(s.bassPc !== undefined ? { bassPc: s.bassPc } : {}),
        sec: overlap,
      };
    }
  }
  return best;
}

export interface SunoFixtureResult {
  q3: {
    slices: { range: [number, number]; expected: string; stemsOn: string | null; mixOn: string | null }[];
    /** stems 経路で 4 スライス全て期待どおりか */
    pass: boolean;
  };
  q2: {
    window: [number, number];
    stemsCmSecOff: number;
    stemsCmSecOn: number;
    mixCmSecOff: number;
    mixCmSecOn: number;
    /** 登録どおりの厳密基準（窓内に Cm 系ゼロ） */
    strictPass: boolean;
    /** 第2段の否定テスト（第2段が Cm 系を新たに作らない・Cm7 を付けない） */
    stage2Pass: boolean;
  };
  q1: {
    windows: {
      range: [number, number];
      stemsDominantOff: { chord: string; extension?: string; bassPc?: number; sec: number } | null;
      stemsDominantOn: { chord: string; extension?: string; bassPc?: number; sec: number } | null;
    }[];
    /** stems で支配的セグメントのベースが D のまま＆第2段がそのセグメントに触れていない */
    pass: boolean;
  };
}

const Q3_SLICES: { range: [number, number]; expected: string; accept: string[] }[] = [
  { range: [85, 87], expected: "C", accept: ["C", "CM7"] },
  { range: [87, 89], expected: "B7", accept: ["B7"] },
  { range: [89, 91], expected: "E7", accept: ["E7"] },
  { range: [91, 93], expected: "Am", accept: ["Am", "Am7"] },
];

export function evaluateSunoFixtures(
  stemsOff: AnalysisResult,
  stemsOn: AnalysisResult,
  mixOff: AnalysisResult,
  mixOn: AnalysisResult,
): SunoFixtureResult {
  const slices = Q3_SLICES.map((s) => ({
    range: s.range,
    expected: s.expected,
    stemsOn: dominantFullLabel(stemsOn, s.range[0], s.range[1])?.label ?? null,
    mixOn: dominantFullLabel(mixOn, s.range[0], s.range[1])?.label ?? null,
  }));
  const q3Pass = Q3_SLICES.every((s, i) => {
    const got = slices[i].stemsOn;
    return got !== null && s.accept.includes(got);
  });

  const q2Window: [number, number] = [153, 168];
  const stemsCmOff = cmTimeInWindow(stemsOff, ...q2Window);
  const stemsCmOn = cmTimeInWindow(stemsOn, ...q2Window);
  const mixCmOff = cmTimeInWindow(mixOff, ...q2Window);
  const mixCmOn = cmTimeInWindow(mixOn, ...q2Window);
  // Cm7 が窓内に現れたら第2段が誤った minor 主張を強めたことになる
  const cm7Appears = (r: AnalysisResult) =>
    r.segments.some(
      (s) =>
        s.end > q2Window[0] &&
        s.start < q2Window[1] &&
        s.chord === "Cm" &&
        s.extension === "m7",
    );
  const q2 = {
    window: q2Window,
    stemsCmSecOff: stemsCmOff,
    stemsCmSecOn: stemsCmOn,
    mixCmSecOff: mixCmOff,
    mixCmSecOn: mixCmOn,
    strictPass: stemsCmOn === 0 && mixCmOn === 0,
    stage2Pass:
      stemsCmOn <= stemsCmOff + 1e-9 &&
      mixCmOn <= mixCmOff + 1e-9 &&
      !cm7Appears(stemsOn) &&
      !cm7Appears(mixOn),
  };

  const q1Windows: [number, number][] = [
    [51, 56],
    [93, 98],
  ];
  const q1Details = q1Windows.map((range) => ({
    range,
    stemsDominantOff: dominantSegment(stemsOff, range[0], range[1]),
    stemsDominantOn: dominantSegment(stemsOn, range[0], range[1]),
  }));
  const q1Pass = q1Details.every((d) => {
    const on = d.stemsDominantOn;
    const off = d.stemsDominantOff;
    return (
      on !== null &&
      off !== null &&
      on.bassPc === 2 && // ベース D の層が壊れていない
      on.chord === off.chord && // 第2段が支配的セグメントのルートを動かしていない
      on.extension === undefined // F / F# の証拠が無いのに 7th を主張していない
    );
  });

  return { q3: { slices, pass: q3Pass }, q2, q1: { windows: q1Details, pass: q1Pass } };
}

export interface SunoRun {
  fixtures: SunoFixtureResult;
  stemsOnSegments: AnalysisResult["segments"];
  mixOnSegments: AnalysisResult["segments"];
}

export async function runPhase3Suno(): Promise<SunoRun> {
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

  const chromas = prepareStemChromas(mix.samples, other.samples, bass.samples, sr);
  const stemsOff = analyzeStemsWithStrategy(chromas, sr, "05.mp3", "s-conditional");
  const stemsOn = analyzeStemsWithStrategy(chromas, sr, "05.mp3", "s-conditional", {
    extensions: true,
  });
  const mixOff = await analyzeAudio(mix.samples, sr, "05.mp3");
  const mixOn = await analyzeAudio(mix.samples, sr, "05.mp3", undefined, {
    extensions: true,
  });

  const fixtures = evaluateSunoFixtures(stemsOff, stemsOn, mixOff, mixOn);
  const run: SunoRun = { fixtures, stemsOnSegments: stemsOn.segments, mixOnSegments: mixOn.segments };
  writeJson("phase3-1-suno.json", run);
  return run;
}

// ---------------------------------------------------------------------------
// Phase 3.3 測定（局所キー文脈＋maj7 文脈 prior、3.1 との共同採用判定用）
//
// アーム定義:
// - off: 第2段なし・局所キーなし（= 記録済みベースライン）
// - on:  Phase 3.1 の第2段のみ（文脈 prior なし）
// - on33: 第2段＋局所キー文脈（モード nudge、局所キー緩和、
//         maj7 背景シェア割り引き）
// しきい値の調整は合成曲と Suno フィクスチャのみ。実曲は検証専用。
// 生成物: measurements/phase3/phase3-3-*.json
// ---------------------------------------------------------------------------

/** maj7 が付いたセグメントの秒数（合計とコード別）。誤発火の定量化用 */
export function maj7Seconds(result: AnalysisResult): {
  total: number;
  byChord: Record<string, number>;
} {
  const byChord: Record<string, number> = {};
  let total = 0;
  for (const s of result.segments) {
    if (s.extension !== "maj7") continue;
    const sec = s.end - s.start;
    total += sec;
    byChord[s.chord] = (byChord[s.chord] ?? 0) + sec;
  }
  const rounded: Record<string, number> = {};
  for (const [k, v] of Object.entries(byChord)) rounded[k] = Number(v.toFixed(1));
  return { total: Number(total.toFixed(1)), byChord: rounded };
}

function localKeyDigest(windows: LocalKeyWindow[] | undefined): string[] {
  return (windows ?? []).map(
    (w) =>
      `${w.start.toFixed(0)}–${w.end.toFixed(0)}:${NOTE_NAMES[w.root]} ${w.mode} ` +
      `(r=${w.correlation.toFixed(2)}, m=${w.margin.toFixed(2)}, 次点 ${NOTE_NAMES[w.runnerUpRoot]} ${w.runnerUpMode})`,
  );
}

/** 窓内のセグメント列を読みやすい文字列にする（結果文書の引用用） */
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

export interface Synthetic33Entry {
  songId: string;
  title: string;
  off: SongMeasurement;
  on: SongMeasurement;
  on33: SongMeasurement;
  extOff: ExtensionMeasurement;
  extOn: ExtensionMeasurement;
  extOn33: ExtensionMeasurement;
}

export async function runPhase33Synthetic(): Promise<Synthetic33Entry[]> {
  mkdirSync(TEST_AUDIO_DIR, { recursive: true });
  const specs: SongSpec[] = [
    ...SONGS,
    ...SLASH_SONGS,
    ...SEVENTH_SONGS,
    ...SECONDARY_DOMINANT_SONGS,
  ];
  const entries: Synthetic33Entry[] = [];
  for (const spec of specs) {
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

    const off = await analyzeAudio(wav.samples, wav.sampleRate, `${spec.id}.wav`, undefined, {
      extensions: false,
      localKey: false,
    });
    const on = await analyzeAudio(wav.samples, wav.sampleRate, `${spec.id}.wav`, undefined, {
      extensions: true,
      localKey: false,
    });
    const on33 = await analyzeAudio(wav.samples, wav.sampleRate, `${spec.id}.wav`, undefined, {
      extensions: true,
      localKey: true,
    });
    entries.push({
      songId: spec.id,
      title: spec.title,
      off: measureSong(truth, off),
      on: measureSong(truth, on),
      on33: measureSong(truth, on33),
      extOff: measureExtensions(extTruth, truth.durationSec, off),
      extOn: measureExtensions(extTruth, truth.durationSec, on),
      extOn33: measureExtensions(extTruth, truth.durationSec, on33),
    });
  }
  writeJson("phase3-3-synthetic.json", entries);
  return entries;
}

export interface Real33Entry {
  slug: string;
  title: string;
  mixOff: RealSongMeasurement | null;
  mixOn: RealSongMeasurement | null;
  mix33: RealSongMeasurement | null;
  mixExtOff: ExtensionMeasurement | null;
  mixExtOn: ExtensionMeasurement | null;
  mixExt33: ExtensionMeasurement | null;
  stemsOff: RealSongMeasurement | null;
  stemsOn: RealSongMeasurement | null;
  stems33: RealSongMeasurement | null;
  stemsExtOff: ExtensionMeasurement | null;
  stemsExtOn: ExtensionMeasurement | null;
  stemsExt33: ExtensionMeasurement | null;
  /** on33 の結果に記録された局所キー窓（要約文字列） */
  mixLocalKeys: string[];
  stemsLocalKeys: string[];
  /** maj7 秒数: 混合音 on33 / ステム off・on・on33 */
  mixMaj7: { total: number; byChord: Record<string, number> } | null;
  stemsMaj7Off: { total: number; byChord: Record<string, number> } | null;
  stemsMaj7On: { total: number; byChord: Record<string, number> } | null;
  stemsMaj7On33: { total: number; byChord: Record<string, number> } | null;
}

function emptyReal33(slug: string, title: string): Real33Entry {
  return {
    slug,
    title,
    mixOff: null, mixOn: null, mix33: null,
    mixExtOff: null, mixExtOn: null, mixExt33: null,
    stemsOff: null, stemsOn: null, stems33: null,
    stemsExtOff: null, stemsExtOn: null, stemsExt33: null,
    mixLocalKeys: [], stemsLocalKeys: [],
    mixMaj7: null, stemsMaj7Off: null, stemsMaj7On: null, stemsMaj7On33: null,
  };
}

export async function runPhase33RealMixture(): Promise<Real33Entry[]> {
  const entries: Real33Entry[] = [];
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

    const off = await analyzeAudio(mix.samples, mix.sampleRate, spec.mixPath, undefined, {
      extensions: false,
      localKey: false,
    });
    const on = await analyzeAudio(mix.samples, mix.sampleRate, spec.mixPath, undefined, {
      extensions: true,
      localKey: false,
    });
    const on33 = await analyzeAudio(mix.samples, mix.sampleRate, spec.mixPath, undefined, {
      extensions: true,
      localKey: true,
    });
    const e = emptyReal33(slug, spec.title);
    e.mixOff = measureRealSong(truth, off, "default");
    e.mixOn = measureRealSong(truth, on, "default+ext");
    e.mix33 = measureRealSong(truth, on33, "default+ext+localkey");
    e.mixExtOff = measureExtensions(extTruth, truth.durationSec, off);
    e.mixExtOn = measureExtensions(extTruth, truth.durationSec, on);
    e.mixExt33 = measureExtensions(extTruth, truth.durationSec, on33);
    e.mixLocalKeys = localKeyDigest(on33.localKeys);
    e.mixMaj7 = maj7Seconds(on33);
    entries.push(e);
  }
  writeJson("phase3-3-real-mixture.json", entries);
  return entries;
}

export async function runPhase33RealStems(): Promise<Real33Entry[]> {
  const entries: Real33Entry[] = [];
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

    const chromas = prepareStemChromas(mix.samples, other.samples, bass.samples, sr);
    const off = analyzeStemsWithStrategy(chromas, sr, slug, "s-conditional", {
      extensions: false,
      localKey: false,
    });
    const on = analyzeStemsWithStrategy(chromas, sr, slug, "s-conditional", {
      extensions: true,
      localKey: false,
    });
    const on33 = analyzeStemsWithStrategy(chromas, sr, slug, "s-conditional", {
      extensions: true,
      localKey: true,
    });
    const e = emptyReal33(slug, spec.title);
    e.stemsOff = measureRealSong(truth, off, "stems-s-conditional");
    e.stemsOn = measureRealSong(truth, on, "stems-s-conditional+ext");
    e.stems33 = measureRealSong(truth, on33, "stems-s-conditional+ext+localkey");
    e.stemsExtOff = measureExtensions(extTruth, truth.durationSec, off);
    e.stemsExtOn = measureExtensions(extTruth, truth.durationSec, on);
    e.stemsExt33 = measureExtensions(extTruth, truth.durationSec, on33);
    e.stemsLocalKeys = localKeyDigest(on33.localKeys);
    e.stemsMaj7Off = maj7Seconds(off);
    e.stemsMaj7On = maj7Seconds(on);
    e.stemsMaj7On33 = maj7Seconds(on33);
    entries.push(e);
  }
  writeJson("phase3-3-real-stems.json", entries);
  return entries;
}

export interface Suno33Run {
  /** Phase 3.1 の評価（on = 第2段のみ）をそのまま再掲 */
  fixtures: SunoFixtureResult;
  /** on33 を「on」として評価したもの（Q2 厳密基準は 3.3 の判定対象） */
  fixtures33: SunoFixtureResult;
  stemsLocalKeys: string[];
  mixLocalKeys: string[];
  /** Q2 窓（153–168s）の stems セグメント列: off / on / on33 */
  q2Segments: { off: string; on: string; on33: string };
  /** Q3 窓（85–93s）の stems セグメント列: on33 */
  q3SegmentsOn33: string;
}

export async function runPhase33Suno(): Promise<Suno33Run> {
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

  const chromas = prepareStemChromas(mix.samples, other.samples, bass.samples, sr);
  const stemsOff = analyzeStemsWithStrategy(chromas, sr, "05.mp3", "s-conditional", {
    extensions: false,
    localKey: false,
  });
  const stemsOn = analyzeStemsWithStrategy(chromas, sr, "05.mp3", "s-conditional", {
    extensions: true,
    localKey: false,
  });
  const stems33 = analyzeStemsWithStrategy(chromas, sr, "05.mp3", "s-conditional", {
    extensions: true,
    localKey: true,
  });
  const mixOff = await analyzeAudio(mix.samples, sr, "05.mp3", undefined, {
    extensions: false,
    localKey: false,
  });
  const mixOn = await analyzeAudio(mix.samples, sr, "05.mp3", undefined, {
    extensions: true,
    localKey: false,
  });
  const mix33 = await analyzeAudio(mix.samples, sr, "05.mp3", undefined, {
    extensions: true,
    localKey: true,
  });

  const run: Suno33Run = {
    fixtures: evaluateSunoFixtures(stemsOff, stemsOn, mixOff, mixOn),
    fixtures33: evaluateSunoFixtures(stemsOff, stems33, mixOff, mix33),
    stemsLocalKeys: localKeyDigest(stems33.localKeys),
    mixLocalKeys: localKeyDigest(mix33.localKeys),
    q2Segments: {
      off: segmentList(stemsOff, 150, 170),
      on: segmentList(stemsOn, 150, 170),
      on33: segmentList(stems33, 150, 170),
    },
    q3SegmentsOn33: segmentList(stems33, 84, 94),
  };
  writeJson("phase3-3-suno.json", run);
  return run;
}

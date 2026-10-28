/**
 * Phase 3.2 測定スイート — 分数コードの層表示（PHASE3_PLAN.md §3.2）。
 *
 * 進め方:
 * - 実装前の全スイートのセグメント列（chord / extension / bassPc と
 *   境界）を captureAll で記録し、実装後と比較する。3.2 は表現の
 *   変更であり、第1段・第2段のラベル（chord / extension / bassPc /
 *   境界）は全スイート・全設定で完全一致しなければならない。
 * - 表示文字列の変化は、従来表示（displayChordName）と層表示
 *   （displaySegmentChord）の差分として列挙・定量化する。
 * - Suno フィクスチャ（Q1 / Q3 / Q4）は表示文字列で判定する
 *   （PHASE3_2_RESULTS.md に登録した受け入れ形）。
 * - add9 のしきい値調整は合成曲（Song G の真陽性＋A–F の対照）と
 *   Suno フィクスチャのみ。実曲 1–3 は検証専用（触らない）。
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
import { displayChordName, displaySegmentChord } from "../src/lib/chordDisplay";
import { NO_CHORD } from "../src/lib/notes";
import type { AnalysisResult, ChordSegment } from "../src/types";
import {
  loadAudioFile,
  parseTruthJson,
  type RealTruth,
  type RealTruthSegment,
} from "./measureReal";
import { findStemWav, STEM_SONGS } from "./measureStems";
import {
  ADD9_SONGS,
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

export function writePhase32Json(name: string, data: unknown): void {
  writeFileSync(join(outDir(), name), JSON.stringify(data, null, 2) + "\n", "utf-8");
}

// ---------------------------------------------------------------------------
// キャプチャ（実装前後の比較用）
// ---------------------------------------------------------------------------

export interface CapturedSegment {
  start: number;
  end: number;
  chord: string;
  extension?: string;
  bassPc?: number;
  upperChord?: string;
  upperExtension?: string;
  addTones?: string[];
  /** 従来表示（displayChordName）。3.2 の前後で定義が変わらない基準表示 */
  displayOld: string;
}

export interface CapturedRun {
  suite: string;
  config: "default" | "ext";
  segments: CapturedSegment[];
}

function capture(result: AnalysisResult, suite: string, config: "default" | "ext"): CapturedRun {
  return {
    suite,
    config,
    segments: result.segments.map((s) => ({
      start: Number(s.start.toFixed(3)),
      end: Number(s.end.toFixed(3)),
      chord: s.chord,
      ...(s.extension ? { extension: s.extension } : {}),
      ...(s.bassPc !== undefined ? { bassPc: s.bassPc } : {}),
      ...(s.upperChord ? { upperChord: s.upperChord } : {}),
      ...(s.upperExtension ? { upperExtension: s.upperExtension } : {}),
      ...(s.addTones ? { addTones: [...s.addTones] } : {}),
      displayOld: displayChordName(s.chord, s.bassPc, s.extension),
    })),
  };
}

const SYNTH_SPECS: SongSpec[] = [
  ...SONGS,
  ...SLASH_SONGS,
  ...SEVENTH_SONGS,
  ...SECONDARY_DOMINANT_SONGS,
  ...ADD9_SONGS,
];

export async function captureSynthetic(): Promise<CapturedRun[]> {
  mkdirSync(TEST_AUDIO_DIR, { recursive: true });
  const runs: CapturedRun[] = [];
  for (const spec of SYNTH_SPECS) {
    const { samples, truth } = synthSong(spec, SAMPLE_RATE);
    const wavPath = join(TEST_AUDIO_DIR, `${spec.id}.wav`);
    const gtPath = join(TEST_AUDIO_DIR, `${spec.id}.groundtruth.json`);
    writeWav16(wavPath, samples, SAMPLE_RATE);
    writeFileSync(gtPath, JSON.stringify(truth, null, 2) + "\n", "utf-8");
    const wav = readWav16(wavPath);
    const off = await analyzeAudio(wav.samples, wav.sampleRate, `${spec.id}.wav`);
    const on = await analyzeAudio(wav.samples, wav.sampleRate, `${spec.id}.wav`, undefined, {
      extensions: true,
    });
    runs.push(capture(off, `synthetic:${spec.id}`, "default"));
    runs.push(capture(on, `synthetic:${spec.id}`, "ext"));
  }
  return runs;
}

const REAL_SLUGS = ["put-your-records-on", "everything", "a-hard-days-night"];

export async function captureRealMixture(): Promise<CapturedRun[]> {
  const runs: CapturedRun[] = [];
  for (const slug of REAL_SLUGS) {
    const spec = STEM_SONGS.find((s) => s.slug === slug)!;
    if (!existsSync(spec.mixPath)) continue;
    const mix = loadAudioFile(spec.mixPath);
    const off = await analyzeAudio(mix.samples, mix.sampleRate, spec.mixPath);
    const on = await analyzeAudio(mix.samples, mix.sampleRate, spec.mixPath, undefined, {
      extensions: true,
    });
    runs.push(capture(off, `real-mix:${slug}`, "default"));
    runs.push(capture(on, `real-mix:${slug}`, "ext"));
  }
  return runs;
}

export async function captureRealStems(): Promise<CapturedRun[]> {
  const runs: CapturedRun[] = [];
  for (const slug of [...REAL_SLUGS, "song-d"]) {
    const spec = STEM_SONGS.find((s) => s.slug === slug)!;
    const otherPath = findStemWav(spec.stemRoot, "other");
    const bassPath = findStemWav(spec.stemRoot, "bass");
    if (!otherPath || !bassPath || !existsSync(spec.mixPath)) continue;
    const mix = loadAudioFile(spec.mixPath);
    const other = loadAudioFile(otherPath);
    const bass = loadAudioFile(bassPath);
    const sr = mix.sampleRate;
    const chromas = prepareStemChromas(mix.samples, other.samples, bass.samples, sr);
    const off = analyzeStemsWithStrategy(chromas, sr, slug, "s-conditional");
    const on = analyzeStemsWithStrategy(chromas, sr, slug, "s-conditional", {
      extensions: true,
    });
    runs.push(capture(off, `real-stems:${slug}`, "default"));
    runs.push(capture(on, `real-stems:${slug}`, "ext"));
  }
  return runs;
}

export interface SunoResults {
  stemsDefault: AnalysisResult;
  stemsExt: AnalysisResult;
  mixDefault: AnalysisResult;
  mixExt: AnalysisResult;
}

export async function runSuno32(): Promise<SunoResults> {
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
  const stemsDefault = analyzeStemsWithStrategy(chromas, sr, "05.mp3", "s-conditional");
  const stemsExt = analyzeStemsWithStrategy(chromas, sr, "05.mp3", "s-conditional", {
    extensions: true,
  });
  const mixDefault = await analyzeAudio(mix.samples, sr, "05.mp3");
  const mixExt = await analyzeAudio(mix.samples, sr, "05.mp3", undefined, {
    extensions: true,
  });
  return { stemsDefault, stemsExt, mixDefault, mixExt };
}

export async function captureSuno(): Promise<CapturedRun[]> {
  const r = await runSuno32();
  return [
    capture(r.stemsDefault, "suno:stems", "default"),
    capture(r.stemsExt, "suno:stems", "ext"),
    capture(r.mixDefault, "suno:mix", "default"),
    capture(r.mixExt, "suno:mix", "ext"),
  ];
}

export async function captureAll(): Promise<CapturedRun[]> {
  return [
    ...(await captureSynthetic()),
    ...(await captureRealMixture()),
    ...(await captureRealStems()),
    ...(await captureSuno()),
  ];
}

// ---------------------------------------------------------------------------
// 実装前後の差分（ラベル不変の証明＋表示変化の列挙）
// ---------------------------------------------------------------------------

export interface LabelDiff {
  suite: string;
  config: string;
  index: number;
  before: CapturedSegment;
  after: CapturedSegment;
}

export interface DisplayChange {
  suite: string;
  config: string;
  start: number;
  end: number;
  chord: string;
  displayBefore: string;
  displayAfter: string;
}

export function labelKey(s: CapturedSegment): string {
  return [
    s.start,
    s.end,
    s.chord,
    s.extension ?? "",
    s.bassPc ?? "",
  ].join("|");
}

/** after 側のセグメント（生の ChordSegment 相当）から層表示を作る */
export function displayAfter(s: CapturedSegment): string {
  const seg = {
    id: 0,
    start: s.start,
    end: s.end,
    chord: s.chord,
    confidence: 0,
    ...(s.extension ? { extension: s.extension } : {}),
    ...(s.bassPc !== undefined ? { bassPc: s.bassPc } : {}),
    ...(s.upperChord ? { upperChord: s.upperChord } : {}),
    ...(s.upperExtension ? { upperExtension: s.upperExtension } : {}),
    ...(s.addTones ? { addTones: s.addTones } : {}),
  } as ChordSegment;
  return displaySegmentChord(seg);
}

export function diffCaptures(
  before: CapturedRun[],
  after: CapturedRun[],
): { labelDiffs: LabelDiff[]; displayChanges: DisplayChange[] } {
  const labelDiffs: LabelDiff[] = [];
  const displayChanges: DisplayChange[] = [];
  const afterMap = new Map(after.map((r) => [`${r.suite}:${r.config}`, r]));
  for (const bRun of before) {
    const aRun = afterMap.get(`${bRun.suite}:${bRun.config}`);
    if (!aRun) {
      labelDiffs.push({
        suite: bRun.suite,
        config: bRun.config,
        index: -1,
        before: bRun.segments[0] ?? ({} as CapturedSegment),
        after: {} as CapturedSegment,
      });
      continue;
    }
    const n = Math.max(bRun.segments.length, aRun.segments.length);
    for (let i = 0; i < n; i++) {
      const b = bRun.segments[i];
      const a = aRun.segments[i];
      if (!b || !a || labelKey(b) !== labelKey(a)) {
        labelDiffs.push({
          suite: bRun.suite,
          config: bRun.config,
          index: i,
          before: b ?? ({} as CapturedSegment),
          after: a ?? ({} as CapturedSegment),
        });
        continue;
      }
      const dAfter = displayAfter(a);
      if (dAfter !== b.displayOld) {
        displayChanges.push({
          suite: bRun.suite,
          config: bRun.config,
          start: a.start,
          end: a.end,
          chord: a.chord,
          displayBefore: b.displayOld,
          displayAfter: dAfter,
        });
      }
    }
  }
  return { labelDiffs, displayChanges };
}

// ---------------------------------------------------------------------------
// Suno フィクスチャ（表示文字列で判定）
// ---------------------------------------------------------------------------

const FIXTURE_STEP = 0.05;

/** 窓内で最も時間を占める表示文字列（N.C. を除く） */
export function dominantDisplay(
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
    const label = displaySegmentChord(det);
    tally.set(label, (tally.get(label) ?? 0) + FIXTURE_STEP);
  }
  let best: { label: string; sec: number } | null = null;
  for (const [label, sec] of tally) {
    if (!best || sec > best.sec) best = { label, sec };
  }
  return best;
}

/** 窓内の表示文字列の内訳（秒数つき、降順） */
export function displayBreakdown(
  result: AnalysisResult,
  lo: number,
  hi: number,
): { label: string; sec: number }[] {
  const tally = new Map<string, number>();
  for (const s of result.segments) {
    const overlap = Math.min(s.end, hi) - Math.max(s.start, lo);
    if (overlap <= 0) continue;
    const label = displaySegmentChord(s);
    tally.set(label, (tally.get(label) ?? 0) + overlap);
  }
  return [...tally.entries()]
    .map(([label, sec]) => ({ label, sec: Number(sec.toFixed(2)) }))
    .sort((a, b) => b.sec - a.sec);
}

export interface Suno32Fixtures {
  q1: {
    windows: {
      range: [number, number];
      stemsDefault: string | null;
      stemsExt: string | null;
      mixExt: string | null;
    }[];
    /** stems（ext / 既定とも）で両窓が登録形 "C/D"（D9sus4 相当の分数形） */
    pass: boolean;
  };
  q4: {
    range: [number, number];
    stemsDefault: string | null;
    stemsExt: string | null;
    mixExt: string | null;
    /** stems で登録形 "CM7/C#"（計画の代替形）または "Am(add9)/C#" */
    pass: boolean;
  };
  q3: {
    slices: { range: [number, number]; expected: string; stemsExt: string | null }[];
    pass: boolean;
  };
  q2: {
    range: [number, number];
    stemsExtBreakdown: { label: string; sec: number }[];
    /**
     * 窓内の Cm 系表示の秒数（記録用）。Q2 の合否基準は 3.3 の
     * 機構（局所キー消費部 ON）でのラベル判定であり、本フィクスチャ
     * （extensions のみ ON）では第1段の Cm ラベルが残るのが既知の
     * 姿。3.2 はラベルを変えないため、ここでは表示の内訳を残すだけ。
     */
    cmDisplaySec: number;
  };
}

const Q3_ACCEPT: { range: [number, number]; expected: string; accept: string[] }[] = [
  { range: [85, 87], expected: "C", accept: ["C", "CM7"] },
  { range: [87, 89], expected: "B7", accept: ["B7"] },
  { range: [89, 91], expected: "E7", accept: ["E7"] },
  { range: [91, 93], expected: "Am", accept: ["Am", "Am7"] },
];

export function evaluateSuno32(r: SunoResults): Suno32Fixtures {
  const q1Ranges: [number, number][] = [
    [51, 56],
    [93, 98],
  ];
  const q1Windows = q1Ranges.map((range) => ({
    range,
    stemsDefault: dominantDisplay(r.stemsDefault, range[0], range[1])?.label ?? null,
    stemsExt: dominantDisplay(r.stemsExt, range[0], range[1])?.label ?? null,
    mixExt: dominantDisplay(r.mixExt, range[0], range[1])?.label ?? null,
  }));
  const q1Pass = q1Windows.every(
    (w) => w.stemsExt === "C/D" && w.stemsDefault === "C/D",
  );

  const q4Range: [number, number] = [62, 65];
  const q4 = {
    range: q4Range,
    stemsDefault: dominantDisplay(r.stemsDefault, ...q4Range)?.label ?? null,
    stemsExt: dominantDisplay(r.stemsExt, ...q4Range)?.label ?? null,
    mixExt: dominantDisplay(r.mixExt, ...q4Range)?.label ?? null,
    pass: false,
  };
  q4.pass =
    q4.stemsExt === "CM7/C#" || q4.stemsExt === "Am(add9)/C#";

  const q3Slices = Q3_ACCEPT.map((s) => ({
    range: s.range,
    expected: s.expected,
    stemsExt: dominantDisplay(r.stemsExt, s.range[0], s.range[1])?.label ?? null,
  }));
  const q3Pass = Q3_ACCEPT.every((s, i) => {
    const got = q3Slices[i].stemsExt;
    return got !== null && s.accept.includes(got);
  });

  const q2Range: [number, number] = [153, 168];
  const q2Breakdown = displayBreakdown(r.stemsExt, ...q2Range);
  const isCmFamily = (label: string) =>
    label === "Cm" ||
    label.startsWith("Cm7") ||
    label.startsWith("Cm/") ||
    label.startsWith("Cm(");
  const cmDisplaySec = q2Breakdown
    .filter((d) => isCmFamily(d.label))
    .reduce((acc, d) => acc + d.sec, 0);

  return {
    q1: { windows: q1Windows, pass: q1Pass },
    q4,
    q3: { slices: q3Slices, pass: q3Pass },
    q2: {
      range: q2Range,
      stemsExtBreakdown: q2Breakdown,
      cmDisplaySec: Number(cmDisplaySec.toFixed(2)),
    },
  };
}

// ---------------------------------------------------------------------------
// Song G（合成 add9／層フィクスチャ）
// ---------------------------------------------------------------------------

export interface SongGCheck {
  bar: number;
  truth: string;
  range: [number, number];
  displayDefault: string | null;
  displayExt: string | null;
  expectDefault: string;
  expectExt: string;
  /** ext 側の期待表示が小節内に占める割合（カバレッジ判定のバー用） */
  extCoverage?: number;
  pass: boolean;
}

export async function runSongG(): Promise<SongGCheck[]> {
  const spec = ADD9_SONGS[0];
  const { samples, truth } = synthSong(spec, SAMPLE_RATE);
  const wavPath = join(TEST_AUDIO_DIR, `${spec.id}.wav`);
  writeWav16(wavPath, samples, SAMPLE_RATE);
  writeFileSync(
    join(TEST_AUDIO_DIR, `${spec.id}.groundtruth.json`),
    JSON.stringify(truth, null, 2) + "\n",
    "utf-8",
  );
  const wav = readWav16(wavPath);
  const off = await analyzeAudio(wav.samples, wav.sampleRate, `${spec.id}.wav`);
  const on = await analyzeAudio(wav.samples, wav.sampleRate, `${spec.id}.wav`, undefined, {
    extensions: true,
  });
  // 正解バーごとの期待表示（1周目で判定。2周目はキャプチャ差分で担保）。
  // add9 のルート位置バー（2・5）はカバレッジ判定にする: 9th 音は
  // アルペジオで1周に1回しか鳴らず、証拠の強い区間（ストラム側）と
  // 弱い区間（アルペジオのみ）でセグメントが割れると、支配的表示が
  // 0.01 秒差で入れ替わるため。「期待表示が小節の30%以上を占める」
  // ことを検出の成立条件とする（根拠は PHASE3_2_RESULTS.md）。
  const expected: { truth: string; def: string; ext: string; coverage?: boolean }[] = [
    { truth: "Am(add9)/C#", def: "Am/C#", ext: "Am(add9)/C#" },
    { truth: "Cadd9", def: "C", ext: "Cadd9", coverage: true },
    { truth: "G", def: "G", ext: "G" },
    { truth: "Am(add9)", def: "Am", ext: "Am(add9)" },
    { truth: "Fadd9", def: "F", ext: "Fadd9", coverage: true },
    { truth: "Em", def: "Em", ext: "Em" },
  ];
  return truth.segments.slice(0, 6).map((s, i) => {
    const dOff = dominantDisplay(off, s.startSec, s.endSec)?.label ?? null;
    const dOn = dominantDisplay(on, s.startSec, s.endSec)?.label ?? null;
    const exp = expected[i];
    let extPass = dOn === exp.ext;
    let extCoverage: number | undefined;
    if (exp.coverage) {
      const barLen = s.endSec - s.startSec;
      const cov =
        displayBreakdown(on, s.startSec, s.endSec).find((d) => d.label === exp.ext)
          ?.sec ?? 0;
      extCoverage = Number((cov / barLen).toFixed(2));
      extPass = extCoverage >= 0.3;
    }
    return {
      bar: i + 1,
      truth: exp.truth,
      range: [s.startSec, s.endSec],
      displayDefault: dOff,
      displayExt: dOn,
      expectDefault: exp.def,
      expectExt: exp.ext,
      ...(extCoverage !== undefined ? { extCoverage } : {}),
      pass: dOff === exp.def && extPass,
    };
  });
}

export function loadCapture(path: string): CapturedRun[] {
  return JSON.parse(readFileSync(path, "utf-8")) as CapturedRun[];
}

// ---------------------------------------------------------------------------
// 実曲での表示一致率（正解譜の完全表記と表示文字列の一致、変更前後の比較）
//
// 正解譜の表記ゆれ（Db と C#、Cmaj7 と CM7）を正規化したうえで、
// 正解セグメント内の時間をサンプリングし、表示文字列が正解の完全
// 表記と一致する割合を測る。絶対値の解釈ではなく「層表示で正解側に
// 近づいたか」の前後比較に使う（正解自体が再構成である留保は
// 実曲測定の従来どおり）。
// ---------------------------------------------------------------------------

const FLAT_TO_SHARP: Record<string, string> = {
  Db: "C#",
  Eb: "D#",
  Gb: "F#",
  Ab: "G#",
  Bb: "A#",
};

export function normalizeDisplayName(name: string): string {
  return name
    .replace(/^([A-G]b)/, (m) => FLAT_TO_SHARP[m] ?? m)
    .replace(/\/([A-G]b)/, (_, m) => `/${FLAT_TO_SHARP[m] ?? m}`)
    .replace("maj7", "M7");
}

function truthDisplayName(seg: RealTruthSegment): string {
  const base = normalizeDisplayName(seg.chord);
  if (base.includes("/")) return base;
  if (seg.bass) {
    const b = FLAT_TO_SHARP[seg.bass] ?? seg.bass;
    const root = base.match(/^[A-G][#b]?/)?.[0];
    const rootSharp = root ? (FLAT_TO_SHARP[root] ?? root) : null;
    if (rootSharp && b !== rootSharp) return `${base}/${b}`;
  }
  return base;
}

export interface DisplayAgreement {
  /** 従来表示（displayChordName）での一致率 */
  before: number;
  /** 層表示（displaySegmentChord）での一致率 */
  after: number;
}

export function displayAgreement(
  truth: RealTruth,
  result: AnalysisResult,
): DisplayAgreement {
  let total = 0;
  let beforeHit = 0;
  let afterHit = 0;
  const segs = result.segments;
  let segIdx = 0;
  for (const t of truth.segments) {
    const expected = truthDisplayName(t);
    for (let time = t.startSec; time < t.endSec; time += FIXTURE_STEP) {
      const mid = time + FIXTURE_STEP / 2;
      while (segIdx < segs.length - 1 && mid >= segs[segIdx].end) segIdx++;
      const det =
        segs[segIdx] && mid >= segs[segIdx].start && mid < segs[segIdx].end
          ? segs[segIdx]
          : null;
      total += FIXTURE_STEP;
      if (!det) continue;
      if (normalizeDisplayName(displayChordName(det.chord, det.bassPc, det.extension)) === expected) {
        beforeHit += FIXTURE_STEP;
      }
      if (normalizeDisplayName(displaySegmentChord(det)) === expected) {
        afterHit += FIXTURE_STEP;
      }
    }
  }
  return {
    before: total > 0 ? beforeHit / total : 0,
    after: total > 0 ? afterHit / total : 0,
  };
}

export interface RealDisplayEntry {
  slug: string;
  mixDefault: DisplayAgreement;
  mixExt: DisplayAgreement;
  stemsDefault: DisplayAgreement | null;
  stemsExt: DisplayAgreement | null;
}

export async function runRealDisplayAgreement(): Promise<RealDisplayEntry[]> {
  const entries: RealDisplayEntry[] = [];
  for (const slug of [...REAL_SLUGS, "song-d"]) {
    const spec = STEM_SONGS.find((s) => s.slug === slug)!;
    if (!existsSync(spec.mixPath) || !existsSync(spec.truthPath)) continue;
    const truth: RealTruth = parseTruthJson(
      JSON.parse(readFileSync(spec.truthPath, "utf-8")),
      slug,
    );
    const mix = loadAudioFile(spec.mixPath);
    const mixDefault = await analyzeAudio(mix.samples, mix.sampleRate, spec.mixPath);
    const mixExt = await analyzeAudio(mix.samples, mix.sampleRate, spec.mixPath, undefined, {
      extensions: true,
    });
    const entry: RealDisplayEntry = {
      slug,
      mixDefault: displayAgreement(truth, mixDefault),
      mixExt: displayAgreement(truth, mixExt),
      stemsDefault: null,
      stemsExt: null,
    };
    const otherPath = findStemWav(spec.stemRoot, "other");
    const bassPath = findStemWav(spec.stemRoot, "bass");
    if (otherPath && bassPath) {
      const other = loadAudioFile(otherPath);
      const bass = loadAudioFile(bassPath);
      const sr = mix.sampleRate;
      const chromas = prepareStemChromas(mix.samples, other.samples, bass.samples, sr);
      entry.stemsDefault = displayAgreement(
        truth,
        analyzeStemsWithStrategy(chromas, sr, slug, "s-conditional"),
      );
      entry.stemsExt = displayAgreement(
        truth,
        analyzeStemsWithStrategy(chromas, sr, slug, "s-conditional", {
          extensions: true,
        }),
      );
    }
    entries.push(entry);
  }
  writePhase32Json("phase3-2-real-display.json", entries);
  return entries;
}

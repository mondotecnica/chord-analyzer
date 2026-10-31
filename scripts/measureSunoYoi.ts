/**
 * 「宵のひかり」Suno ステム直接入力の検証測定（正解譜なし・比較指標のみ）。
 *
 * 背景: ユーザーが Suno から書き出した自作曲「宵のひかり」の 9 ステム
 * （Vocals / Backing Vocals / Bass / Drums / Guitar / Keyboard / Synth /
 * Strings / FX、各 212.80 秒・48kHz、MP3 経由で受領）を材料に、
 * 「Suno ステムを直接入力すると Demucs 経由より良い解析になるか」を測る。
 * 本曲は 05.mp3 と同一曲（親検証: ステム合計と 05 のクロマ相関 0.982、
 * ラグ ≒ 0）。05 はユーザーが Logic でミックスした末尾の短い別版
 * （205.14 秒）であり、その既存結果は「参考アーム」として別枠で併記する。
 *
 * アーム:
 *   A 混合音経路 … 9ステム合計ミックスを製品既定（analyzeAudio）で解析
 *   B Demucs 経路 … 合計ミックスをローカル HTDemucs で 4ステム分離し、
 *      製品の高精度入口 analyzeStemsAudio（s-conditional）で解析
 *   C Suno ステム経路 … 9ステムを製品のステム役割へ写像して同じ入口で解析
 *      写像: bass = Bass、other = Guitar+Keyboard+Synth+Strings+FX、
 *      mix = 9ステム合計。製品のステム経路はコード判定に mix / other /
 *      bass しか使わない（vocals / drums は判定に一切使われない設計、
 *      src/analysis/analyzeStems.ts 冒頭表）。したがって Vocals /
 *      Backing Vocals / Drums は合計ミックス経由でのみ効く
 *   D 変種 … C の other から FX を除く（Guitar+Keyboard+Synth+Strings）
 *   C44 … C の交絡切り分け（2026-10-29 追加）: 9ステム相当の入力
 *      （bass / other）を ffmpeg で 44.1kHz 化してから C と同じ写像で
 *      解析する。48kHz ネイティブ解析だった C との差が、そのまま
 *      「C の不利のうち 48kHz 要因の分」になる。素材は bass44.wav /
 *      other_suno44.wav（ffmpeg -ar 44100、mix は既存の mix44.wav）
 *
 * 注意（2026-10-29 の解析レート統一以降）: 解析入口が入力を 44.1kHz
 * へ正規化するようになったため、アーム A / C / D（48kHz 入力）の
 * 結果は初回測定（measurements/SUNO_YOI_ANALYSIS.md）から変わる。
 * A44 / B は 44.1kHz 入力のため不変で、不変性の錨として使う。
 * 詳細は measurements/CHROMA_48K_FIX.md と SUNO_YOI_ANALYSIS.md 追記。
 *
 * 正解コード譜は存在しないため、絶対精度は出さない。比較指標
 * （N.C. 率、断片化、アーム間一致率、信頼度分布）と、05 で確定した
 * ユーザ耳チェックフィクスチャ Q1〜Q4（オフセット ≒ 0 のため同じ時刻に
 * 適用可能）で評価する。
 *
 * 前提ファイル（stem-work/suno-yoi/）:
 *   src/*.wav（MP3 デコード）, mix.wav / other_suno.wav /
 *   other_suno_nofx.wav（scripts/sunoYoiStemQuality.py prep で作成）,
 *   mix44.wav（B の mix 入力用 44.1kHz 版）,
 *   htdemucs/mix/*.wav（tools/run_demucs.py で分離）
 * 実行: npm run measure:suno-yoi
 * 結果: measurements/suno-yoi-results.json
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeAudio } from "../src/analysis/analyze";
import { analyzeStemsAudio } from "../src/analysis/analyzeStems";
import { parseChordName } from "../src/analysis/bassCorrection";
import { displaySegmentChord } from "../src/lib/chordDisplay";
import { NO_CHORD, NOTE_NAMES } from "../src/lib/notes";
import type { AnalysisResult, ChordSegment } from "../src/types";
import {
  cmTimeInWindow,
  dominantFullLabel,
  dominantSegment,
} from "./measurePhase3";
import { runDiagnostic2 } from "./sunoYoiChromaDiagnostic2";
import { readWav16 } from "./wav";

const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));
const WORK = join(PROJECT_ROOT, "stem-work/suno-yoi");
const RESULTS_PATH = join(PROJECT_ROOT, "measurements/suno-yoi-results.json");
const SUNO05_RESULTS = join(PROJECT_ROOT, "measurements/suno-05-results.json");

export function sunoYoiReady(): boolean {
  return (
    existsSync(join(WORK, "mix.wav")) &&
    existsSync(join(WORK, "other_suno.wav")) &&
    existsSync(join(WORK, "htdemucs/mix/other.wav")) &&
    existsSync(join(WORK, "bass44.wav")) &&
    existsSync(join(WORK, "other_suno44.wav"))
  );
}

// ---------------------------------------------------------------------------
// ラベル抽出（3レベル）
// ---------------------------------------------------------------------------

type SegLike = Pick<
  ChordSegment,
  "start" | "end" | "chord" | "confidence" | "extension" | "bassPc" |
  "upperChord" | "upperExtension" | "addTones"
>;

function rootLabel(seg: SegLike): string {
  const p = parseChordName(seg.chord);
  return p ? NOTE_NAMES[p.root] : "N.C.";
}
function triadLabel(seg: SegLike): string {
  const p = parseChordName(seg.chord);
  return p ? `${NOTE_NAMES[p.root]}:${p.mode}` : "N.C.";
}
function fullLabel(seg: SegLike): string {
  if (seg.chord === NO_CHORD) return "N.C.";
  return displaySegmentChord(seg as ChordSegment);
}

const STEP = 0.1;

function sampleLabels(
  segments: SegLike[],
  duration: number,
  fn: (s: SegLike) => string,
): string[] {
  const out: string[] = [];
  let idx = 0;
  for (let t = 0; t < duration - 1e-9; t += STEP) {
    const mid = t + STEP / 2;
    while (idx < segments.length - 1 && mid >= segments[idx].end) idx++;
    const s = segments[idx];
    out.push(s && mid >= s.start && mid < s.end ? fn(s) : "N.C.");
  }
  return out;
}

function agreement(a: string[], b: string[]): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let eq = 0;
  for (let i = 0; i < n; i++) if (a[i] === b[i]) eq++;
  return (eq / n) * 100;
}

/** 両方とも非 N.C. の範囲に限った一致率（片方でも N.C. の標本は除外） */
function agreementBothNonNc(a: string[], b: string[]): number | null {
  const n = Math.min(a.length, b.length);
  let eq = 0;
  let tot = 0;
  for (let i = 0; i < n; i++) {
    if (a[i] === "N.C." || b[i] === "N.C.") continue;
    tot++;
    if (a[i] === b[i]) eq++;
  }
  return tot > 0 ? (eq / tot) * 100 : null;
}

// ---------------------------------------------------------------------------
// アーム要約
// ---------------------------------------------------------------------------

function weightedQuantile(
  segs: SegLike[],
  q: number,
): number {
  const sorted = [...segs].sort((x, y) => x.confidence - y.confidence);
  const total = sorted.reduce((a, s) => a + (s.end - s.start), 0);
  let acc = 0;
  for (const s of sorted) {
    acc += s.end - s.start;
    if (acc / total >= q) return s.confidence;
  }
  return sorted.length ? sorted[sorted.length - 1].confidence : 0;
}

export interface ArmSummary {
  keyName: string;
  keyRoot: number;
  keyMode: string;
  bpm: number | null;
  duration: number;
  segmentCount: number;
  meanSegmentSec: number;
  medianSegmentSec: number;
  ncSharePct: number;
  confidence: {
    durationWeightedMean: number;
    p10: number;
    p50: number;
    p90: number;
    /** 信頼度 < 0.55 の時間割合 [%] */
    lowSharePct: number;
  };
  localKeys: {
    windows: number;
    switches: number;
    top: { key: string; windows: number; sharePct: number }[];
  } | null;
  segments: {
    start: number;
    end: number;
    chord: string;
    display: string;
    confidence: number;
    extension?: string;
    bassPc?: number;
    upperChord?: string;
  }[];
}

function summarize(result: AnalysisResult): ArmSummary {
  const segs = result.segments;
  const dur = result.duration;
  const ncSec = segs
    .filter((s) => s.chord === NO_CHORD)
    .reduce((a, s) => a + (s.end - s.start), 0);
  const lengths = segs.map((s) => s.end - s.start).sort((a, b) => a - b);
  const lowSec = segs
    .filter((s) => s.confidence < 0.55)
    .reduce((a, s) => a + (s.end - s.start), 0);
  const confMean =
    segs.reduce((a, s) => a + s.confidence * (s.end - s.start), 0) / dur;

  let localKeys: ArmSummary["localKeys"] = null;
  if (result.localKeys && result.localKeys.length > 0) {
    // 窓は 12 秒・ホップ 4 秒で重なるため、秒数合算ではなく窓数で集計する
    const tally = new Map<string, number>();
    let switches = 0;
    result.localKeys.forEach((w, i) => {
      const key = `${NOTE_NAMES[w.root]} ${w.mode}`;
      tally.set(key, (tally.get(key) ?? 0) + 1);
      if (i > 0) {
        const prev = result.localKeys![i - 1];
        if (prev.root !== w.root || prev.mode !== w.mode) switches++;
      }
    });
    const totalWin = result.localKeys.length;
    localKeys = {
      windows: totalWin,
      switches,
      top: [...tally.entries()]
        .map(([key, windows]) => ({
          key,
          windows,
          sharePct: Math.round((windows / totalWin) * 1000) / 10,
        }))
        .sort((a, b) => b.windows - a.windows)
        .slice(0, 5),
    };
  }

  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  return {
    keyName: result.keyName,
    keyRoot: result.keyRoot,
    keyMode: result.keyMode,
    bpm: result.bpm,
    duration: dur,
    segmentCount: segs.length,
    meanSegmentSec: r3(dur / Math.max(1, segs.length)),
    medianSegmentSec: lengths.length ? r3(lengths[Math.floor(lengths.length / 2)]) : 0,
    ncSharePct: Math.round((ncSec / dur) * 1000) / 10,
    confidence: {
      durationWeightedMean: r3(confMean),
      p10: r3(weightedQuantile(segs, 0.1)),
      p50: r3(weightedQuantile(segs, 0.5)),
      p90: r3(weightedQuantile(segs, 0.9)),
      lowSharePct: Math.round((lowSec / dur) * 1000) / 10,
    },
    localKeys,
    segments: segs.map((s) => ({
      start: r3(s.start),
      end: r3(s.end),
      chord: s.chord,
      display: fullLabel(s),
      confidence: r3(s.confidence),
      ...(s.extension ? { extension: s.extension } : {}),
      ...(s.bassPc !== undefined ? { bassPc: s.bassPc } : {}),
      ...(s.upperChord ? { upperChord: s.upperChord } : {}),
    })),
  };
}

// ---------------------------------------------------------------------------
// Q1〜Q4 フィクスチャ（05 の耳チェック決着、同じ時刻に適用）
// ---------------------------------------------------------------------------

const Q3_SLICES: { range: [number, number]; expected: string; accept: string[]; triad: string }[] = [
  { range: [85, 87], expected: "C", accept: ["C", "CM7"], triad: "C:major" },
  { range: [87, 89], expected: "B7", accept: ["B7"], triad: "B:major" },
  { range: [89, 91], expected: "E7", accept: ["E7"], triad: "E:major" },
  { range: [91, 93], expected: "Am", accept: ["Am", "Am7"], triad: "A:minor" },
];

function maxOverlapDisplay(result: AnalysisResult, lo: number, hi: number): string | null {
  let best: ChordSegment | null = null;
  let bestOv = -1;
  for (const s of result.segments) {
    const ov = Math.min(s.end, hi) - Math.max(s.start, lo);
    if (ov > bestOv) {
      bestOv = ov;
      best = s;
    }
  }
  return best ? displaySegmentChord(best) : null;
}

function fixtures(result: AnalysisResult) {
  const q1Ranges: [number, number][] = [
    [51, 56],
    [93, 98],
  ];
  const q1 = q1Ranges.map((range) => {
    const dominant = dominantSegment(result, range[0], range[1]);
    return {
      range,
      dominant,
      /** 決着: ベースは D（bassPc=2）が正 */
      bassCorrect: dominant?.bassPc === 2,
      /** 決着: 表示は層表示 C/D（上層 C メジャー＋ベース D） */
      display: maxOverlapDisplay(result, range[0], range[1]),
    };
  });
  const q4Dominant = dominantSegment(result, 62, 65);
  const q4 = {
    dominant: q4Dominant,
    /** 決着: ベース C#（bassPc=1）が実在 */
    bassCorrect: q4Dominant?.bassPc === 1,
    /** 決着: 表示は CM7/C# */
    display: maxOverlapDisplay(result, 62, 65),
  };
  const q3 = Q3_SLICES.map((s) => {
    const dom = dominantFullLabel(result, s.range[0], s.range[1]);
    // 三和音レベルの支配ラベル（第2段 OFF の製品既定では 7th は付かないため併記）
    const triSamples = sampleLabels(result.segments, result.duration, triadLabel);
    const i0 = Math.floor(s.range[0] / STEP);
    const i1 = Math.floor(s.range[1] / STEP);
    const tally = new Map<string, number>();
    for (let i = i0; i < i1 && i < triSamples.length; i++) {
      if (triSamples[i] !== "N.C.") tally.set(triSamples[i], (tally.get(triSamples[i]) ?? 0) + 1);
    }
    let triDom: string | null = null;
    let triBest = -1;
    for (const [k, v] of tally) if (v > triBest) { triBest = v; triDom = k; }
    return {
      range: s.range,
      expected: s.expected,
      label: dom?.label ?? null,
      pass: dom !== null && s.accept.includes(dom.label),
      triadDominant: triDom,
      triadPass: triDom === s.triad,
    };
  });
  const q2Sub = [
    [153, 158],
    [158, 163],
    [163, 168],
  ].map(([lo, hi]) => ({
    range: [lo, hi] as [number, number],
    dominant: dominantFullLabel(result, lo, hi)?.label ?? null,
  }));
  return {
    q1,
    q4,
    q3,
    /** 決着: Cm は棄却済み（Cm 秒数は小さいほど良い）。実態は Am→C の動き */
    q2: { cmSec: cmTimeInWindow(result, 153, 168), subWindows: q2Sub },
  };
}

// ---------------------------------------------------------------------------
// 不一致ウィンドウ（A/B/C の三和音レベルで割れる代表区間）
// ---------------------------------------------------------------------------

interface SampledArm {
  id: string;
  segments: SegLike[];
  duration: number;
}

function disagreementWindows(arms: SampledArm[], topN = 10) {
  const dur = Math.min(...arms.map((a) => a.duration));
  const tri = arms.map((a) => sampleLabels(a.segments, dur, triadLabel));
  const full = arms.map((a) => sampleLabels(a.segments, dur, fullLabel));
  const n = tri[0].length;
  const differ = new Array<boolean>(n).fill(false);
  for (let i = 0; i < n; i++) {
    differ[i] = !(tri[0][i] === tri[1][i] && tri[1][i] === tri[2][i]);
  }
  // ラン抽出（0.3 秒以内の隙間は橋渡し）
  const runs: { start: number; end: number }[] = [];
  let i = 0;
  while (i < n) {
    if (!differ[i]) { i++; continue; }
    let j = i;
    let lastDiff = i;
    while (j < n && j - lastDiff <= 3) {
      if (differ[j]) lastDiff = j;
      j++;
    }
    runs.push({ start: i * STEP, end: (lastDiff + 1) * STEP });
    i = j;
  }
  const dominant = (labels: string[], lo: number, hi: number): string | null => {
    const tally = new Map<string, number>();
    for (let k = Math.floor(lo / STEP); k < Math.floor(hi / STEP) && k < labels.length; k++) {
      tally.set(labels[k], (tally.get(labels[k]) ?? 0) + 1);
    }
    let best: string | null = null;
    let bv = -1;
    for (const [k, v] of tally) if (v > bv) { bv = v; best = k; }
    return best;
  };
  const mmss = (t: number) =>
    `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
  return runs
    .filter((r) => r.end - r.start >= 1.2)
    .sort((a, b) => b.end - b.start - (a.end - a.start))
    .slice(0, topN)
    .map((r) => ({
      startSec: Math.round(r.start * 10) / 10,
      endSec: Math.round(r.end * 10) / 10,
      range: `${mmss(r.start)}–${mmss(r.end)}`,
      durationSec: Math.round((r.end - r.start) * 10) / 10,
      arms: Object.fromEntries(
        arms.map((a, k) => [
          a.id,
          {
            triad: dominant(tri[k], r.start, r.end),
            full: dominant(full[k], r.start, r.end),
          },
        ]),
      ),
    }));
}

// ---------------------------------------------------------------------------
// 本体
// ---------------------------------------------------------------------------

export async function runSunoYoi() {
  const mix = readWav16(join(WORK, "mix.wav"));
  const mix44 = readWav16(join(WORK, "mix44.wav"));
  const bassSuno = readWav16(join(WORK, "src/bass.wav"));
  const otherSuno = readWav16(join(WORK, "other_suno.wav"));
  const otherNoFx = readWav16(join(WORK, "other_suno_nofx.wav"));
  const demDir = join(WORK, "htdemucs/mix");
  const dem = {
    vocals: readWav16(join(demDir, "vocals.wav")),
    drums: readWav16(join(demDir, "drums.wav")),
    bass: readWav16(join(demDir, "bass.wav")),
    other: readWav16(join(demDir, "other.wav")),
  };

  // A: 混合音経路（製品既定そのまま）
  const resA = await analyzeAudio(mix.samples, mix.sampleRate, "宵のひかり（ステム合計）.wav");
  // B: Demucs 経路（製品の高精度入口。mix は分離入力と同一音声の 44.1kHz 版）
  const resB = await analyzeStemsAudio({
    mixSamples: mix44.samples,
    otherSamples: dem.other.samples,
    bassSamples: dem.bass.samples,
    sampleRate: dem.other.sampleRate,
    fileName: "宵のひかり（ステム合計）.wav",
    separationModel: "htdemucs (local torch)",
  });
  // C: Suno ステム経路（写像: bass=Bass, other=G+K+Sy+St+FX, mix=合計）
  const resC = await analyzeStemsAudio({
    mixSamples: mix.samples,
    otherSamples: otherSuno.samples,
    bassSamples: bassSuno.samples,
    sampleRate: mix.sampleRate,
    fileName: "宵のひかり（Suno stems）.wav",
    separationModel: "suno-export-9stems",
  });
  // D: 変種（other から FX を除く）
  const resD = await analyzeStemsAudio({
    mixSamples: mix.samples,
    otherSamples: otherNoFx.samples,
    bassSamples: bassSuno.samples,
    sampleRate: mix.sampleRate,
    fileName: "宵のひかり（Suno stems, other-FX）.wav",
    separationModel: "suno-export-9stems-nofx",
  });
  // C44: C と同じ写像だが、入力を事前に ffmpeg で 44.1kHz 化した版。
  // C（48kHz 入力。レート統一後は入口で線形補間リサンプルされる）と
  // 並べることで、48kHz 要因と「リサンプラの違い」の両方を見られる
  const bass44 = readWav16(join(WORK, "bass44.wav"));
  const other44 = readWav16(join(WORK, "other_suno44.wav"));
  const resC44 = await analyzeStemsAudio({
    mixSamples: mix44.samples,
    otherSamples: other44.samples,
    bassSamples: bass44.samples,
    sampleRate: mix44.sampleRate,
    fileName: "宵のひかり（Suno stems・44.1kHz）.wav",
    separationModel: "suno-export-9stems-44k",
  });

  const arms: Record<string, AnalysisResult> = {
    A: resA,
    B: resB,
    C: resC,
    D: resD,
    C44: resC44,
  };
  const summaries: Record<string, ArmSummary> = {};
  for (const [id, r] of Object.entries(arms)) summaries[id] = summarize(r);

  // 診断コントロール A44: 合計ミックスを 44.1kHz で混合音解析したもの。
  // アーム A（48kHz）の異常の切り分け用（詳細は diagnostics 節）。
  const resA44 = await analyzeAudio(mix44.samples, mix44.sampleRate, "宵のひかり（ステム合計・44.1kHz）.wav");

  // 一致率（ペア＋3者、0〜212.8 秒）。A は 48kHz 異常の影響下にあるため、
  // 混合音の代表は A44 を本線とし、A とのペアは参考として併記する
  const dur = Math.min(...Object.values(arms).map((r) => r.duration));
  const sampled: Record<string, Record<string, string[]>> = {};
  for (const [id, r] of Object.entries({ ...arms, A44: resA44 })) {
    sampled[id] = {
      root: sampleLabels(r.segments, dur, rootLabel),
      triad: sampleLabels(r.segments, dur, triadLabel),
      full: sampleLabels(r.segments, dur, fullLabel),
    };
  }
  const pair = (x: string, y: string) => ({
    root: Math.round(agreement(sampled[x].root, sampled[y].root) * 10) / 10,
    triad: Math.round(agreement(sampled[x].triad, sampled[y].triad) * 10) / 10,
    full: Math.round(agreement(sampled[x].full, sampled[y].full) * 10) / 10,
    triadBothNonNc:
      agreementBothNonNc(sampled[x].triad, sampled[y].triad) !== null
        ? Math.round(agreementBothNonNc(sampled[x].triad, sampled[y].triad)! * 10) / 10
        : null,
  });
  const triple = (level: string) => {
    const [a, b, c] = [sampled.A44[level], sampled.B[level], sampled.C[level]];
    const n = Math.min(a.length, b.length, c.length);
    let eq = 0;
    for (let i = 0; i < n; i++) if (a[i] === b[i] && b[i] === c[i]) eq++;
    return Math.round((eq / n) * 1000) / 10;
  };
  const agreementOut = {
    pairs: {
      A44B: pair("A44", "B"),
      A44C: pair("A44", "C"),
      BC: pair("B", "C"),
      CD: pair("C", "D"),
      AB: pair("A", "B"),
      AC: pair("A", "C"),
      // C44（44.1kHz 化した Suno ステム経路）との比較
      BC44: pair("B", "C44"),
      CC44: pair("C", "C44"),
      A44C44: pair("A44", "C44"),
      AA44: pair("A", "A44"),
    },
    tripleA44BC: {
      root: triple("root"),
      triad: triple("triad"),
      full: triple("full"),
    },
  };

  // 参考アーム: 05.mp3（本人ミックス版）の既存結果（205.14 秒まで比較可能）
  let reference: unknown = null;
  if (existsSync(SUNO05_RESULTS)) {
    const j = JSON.parse(readFileSync(SUNO05_RESULTS, "utf-8"));
    const refArms: Record<string, { segments: SegLike[]; duration: number }> = {
      refMix: { segments: j.mixture.segments, duration: j.mixture.duration },
      refStems: { segments: j.stems.segments, duration: j.stems.duration },
    };
    const refDur = 205.14;
    const refSampled: Record<string, Record<string, string[]>> = {};
    for (const [id, r] of Object.entries(refArms)) {
      refSampled[id] = {
        root: sampleLabels(r.segments, refDur, rootLabel),
        triad: sampleLabels(r.segments, refDur, triadLabel),
        full: sampleLabels(r.segments, refDur, fullLabel),
      };
    }
    const mainTri = sampleLabels(resC.segments, refDur, triadLabel);
    const mainRoot = sampleLabels(resC.segments, refDur, rootLabel);
    const mainFull = sampleLabels(resC.segments, refDur, fullLabel);
    const ncOf = (segs: SegLike[], d: number) =>
      Math.round(
        (segs.filter((s) => s.chord === NO_CHORD).reduce((a, s) => a + (s.end - s.start), 0) / d) *
          1000,
      ) / 10;
    reference = {
      note:
        "05.mp3 = ユーザーが Logic でミックスした本人版（末尾が約7.7秒短い）。" +
        "バランスはステム素の合計と異なる別物。suno-05-results.json（git dc34709 時点）から転記・再集計。",
      mixture: {
        keyName: `${NOTE_NAMES[j.mixture.keyRoot]} ${j.mixture.keyMode}`,
        bpm: j.mixture.bpm,
        segmentCount: j.mixture.segments.length,
        ncSharePct: ncOf(j.mixture.segments, j.mixture.duration),
      },
      stems: {
        keyName: `${NOTE_NAMES[j.stems.keyRoot]} ${j.stems.keyMode}`,
        bpm: j.stems.bpm,
        segmentCount: j.stems.segments.length,
        ncSharePct: ncOf(j.stems.segments, j.stems.duration),
      },
      vsArmC_0to205: {
        rootVsRefMix: Math.round(agreement(mainRoot, refSampled.refMix.root) * 10) / 10,
        triadVsRefMix: Math.round(agreement(mainTri, refSampled.refMix.triad) * 10) / 10,
        rootVsRefStems: Math.round(agreement(mainRoot, refSampled.refStems.root) * 10) / 10,
        triadVsRefStems: Math.round(agreement(mainTri, refSampled.refStems.triad) * 10) / 10,
        fullVsRefStems: Math.round(agreement(mainFull, refSampled.refStems.full) * 10) / 10,
      },
    };
  }

  // 診断: アーム A（48kHz）の異常の切り分け結果。
  // synth / 05@48k プローブは sunoYoiChromaDiagnostic2.ts を参照。
  const diagnostics = {
    note:
      "アーム A（48kHz 混合音）が +1 半音側の世界を読む異常の切り分け。" +
      "素材側の音程は教科書クロマで正常（05 と回転 0 で cos 0.989）であり、" +
      "異常は解析側の 48kHz クロマ（FFT 4096 の低域ビン量子化）に起因する。" +
      "詳細は SUNO_YOI_ANALYSIS.md の診断節。",
    a44MixtureSummary: summarize(resA44),
    srProbe: await runDiagnostic2(),
  };

  const prepInfo = existsSync(join(WORK, "prep-info.json"))
    ? JSON.parse(readFileSync(join(WORK, "prep-info.json"), "utf-8"))
    : null;
  const stemQuality = existsSync(join(WORK, "stem-quality.json"))
    ? JSON.parse(readFileSync(join(WORK, "stem-quality.json"), "utf-8"))
    : null;

  const out = {
    song: "宵のひかり（= 05.mp3 と同一曲、05 は末尾の短い本人ミックス版）",
    note: "公式コード譜なし。正解率ではなくアーム間比較と 05 フィクスチャで評価する。",
    file: {
      stems: 9,
      durationSec: 212.8,
      sampleRate: 48000,
      sourceFormat: "MP3（ユーザーが WAV から変換してアップロード）",
    },
    prep: prepInfo,
    arms: summaries,
    agreement: agreementOut,
    fixtures: { B: fixtures(resB), C: fixtures(resC), C44: fixtures(resC44) },
    disagreementWindows: disagreementWindows([
      { id: "A44", segments: resA44.segments, duration: resA44.duration },
      { id: "B", segments: resB.segments, duration: resB.duration },
      { id: "C", segments: resC.segments, duration: resC.duration },
    ]),
    reference05: reference,
    diagnostics,
    stemQuality,
  };
  writeFileSync(RESULTS_PATH, JSON.stringify(out, null, 1));
  return out;
}

/**
 * 音符レベル統合の測定スイート（NOTEPITCH_INTEGRATION.md の事前登録
 * 基準に対応）。3つの統合（noteBass / noteTension / noteBoundaries）を
 * 各々単独 ON と全 ON で測り、同一ハーネス内の OFF アーム（現行既定
 * パイプライン）と比較する。
 *
 * 比較条件の注記:
 * - フレームゲートは現行既定（曲参照ゲート）のままにする。混合音
 *   経路では従来ゲートとビット一致するため、混合音の OFF は
 *   Phase 3.1 の記録値（legacy 固定）を再現する。ステム経路の OFF は
 *   ゲート再設計後の現行既定が基準であり、Phase 3.1 の記録値とは
 *   N.C. 率の分だけ異なる（判定は同一ハーネス内の差分で行う）。
 * - 音符入力は検証時の音符キャッシュ（measurements/notepitch/notes/、
 *   Basic Pitch ONNX 抽出）。曲3 stems と実曲・Suno の混合音は
 *   統合測定にあわせ同一手法で追加抽出した。
 * - しきい値の調整は合成曲と Suno フィクスチャのみ。実曲は検証専用。
 *
 * 生成物: measurements/notepitch/notepitch-integration-<suite>.json
 * （スイートごとに分けて並行実行時の競合を避ける）
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
import { displaySegmentChord } from "../src/lib/chordDisplay";
import type { NoteEvent, NoteEvidenceInput } from "../src/analysis/noteEvidence";
import type { AnalysisResult } from "../src/types";
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
import {
  cmTimeInWindow,
  dominantFullLabel,
  dominantSegment,
  maj7Seconds,
} from "./measurePhase3";
import { measureSong, parseChord, type SongMeasurement } from "./measureSynthetic";
import {
  ADD9_SONGS,
  BLUES_SONGS,
  ROCK_SONGS,
  SECONDARY_DOMINANT_SONGS,
  SEVENTH_SONGS,
  SLASH_SONGS,
  SONGS,
  synthSong,
  type GroundTruth,
  type SongSpec,
} from "./synth";
import { readWav16, writeWav16 } from "./wav";

const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));
const TEST_AUDIO_DIR = join(PROJECT_ROOT, "test-audio");
const OUT_DIR = join(PROJECT_ROOT, "measurements", "notepitch");
const SAMPLE_RATE = 44100;

function writeResults(suite: string, patch: Record<string, unknown>): void {
  mkdirSync(OUT_DIR, { recursive: true });
  const path = join(OUT_DIR, `notepitch-integration-${suite}.json`);
  const prev = existsSync(path)
    ? (JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>)
    : {};
  writeFileSync(path, JSON.stringify({ ...prev, ...patch }, null, 2) + "\n", "utf-8");
}

// ---------------------------------------------------------------------------
// 音符キャッシュの読み込み
// ---------------------------------------------------------------------------

export function loadNotes(name: string): NoteEvent[] {
  const raw = JSON.parse(
    readFileSync(join(OUT_DIR, "notes", name), "utf-8"),
  ) as { notes: { s: number; e: number; p: number; a: number }[] };
  return raw.notes.map((n) => ({
    start: n.s,
    end: n.e,
    pitch: n.p,
    amplitude: n.a,
  }));
}

// ---------------------------------------------------------------------------
// アーム定義
// ---------------------------------------------------------------------------

export interface ArmDef {
  id: string;
  label: string;
  options: {
    extensions?: boolean;
    noteBass?: boolean;
    noteBassRewrite?: boolean;
    noteTension?: boolean;
    noteTensionMode?: "replace" | "bonus" | "gated" | "veto";
    noteBoundaries?: boolean;
  };
}

/**
 * v2 再試行のアーム（NOTEPITCH_RETRY.md の事前登録）。
 * v1 のアーム（bass / tension / tensionBonus / boundaries /
 * extBoundaries / all）は前ラウンドの JSON に記録済みで、本
 * ラウンドでは差し替える。bassV2r は混合音経路では構造的に
 * bassV2 と同一になる（書き換えは stems 限定）。
 */
export const ARMS: ArmDef[] = [
  // off／ext は採用前ベースラインの再現が目的なので、noteBass の
  // 既定化（2026-10-29 採用）以降も明示 false で固定する。
  { id: "off", label: "全 OFF（採用前ベースライン）", options: { noteBass: false } },
  {
    id: "ext",
    label: "第2段のみ（現行の拡張音検出）",
    options: { extensions: true, noteBass: false },
  },
  { id: "bassV2", label: "noteBass v2（付け替えのみ）", options: { noteBass: true } },
  {
    id: "bassV2r",
    label: "noteBass v2＋厳格化書き換え（stems のみ作用）",
    options: { noteBass: true, noteBassRewrite: true },
  },
  {
    id: "tensionV2",
    label: "第2段＋noteTension v2（veto、棄権つき証人）",
    // noteBass は採用前ベースライン固定（第2段の再解釈ゲートが
    // bassPc を参照するため、付け替えが既定化された後は明示
    // false にしないと再試行時の記録と一致しなくなる）
    options: {
      extensions: true,
      noteTension: true,
      noteTensionMode: "veto",
      noteBass: false,
    },
  },
  {
    id: "tensionGated",
    label: "第2段＋noteTension v2（gated、比較形）",
    options: {
      extensions: true,
      noteTension: true,
      noteTensionMode: "gated",
      noteBass: false,
    },
  },
];

// ---------------------------------------------------------------------------
// 分数小節の指標（合成曲）: 正解に bassPc を持つ区間について、
// ベース正否と表示一致（displaySegmentChord）を測る
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

export interface SlashMetrics {
  /** 正解が分数（bass ≠ ルート）である区間の秒数 */
  slashSec: number;
  /** その区間で検出 bassPc が正解 bassPc と一致した割合 */
  bassAccuracyOnSlash: number | null;
  /** その区間で表示文字列が正解の完全表記と一致した割合 */
  displayAgreementOnSlash: number | null;
  /** 全区間での表示一致率（参考） */
  displayAgreementAll: number | null;
}

const SLASH_STEP = 0.01;

export function slashMetrics(truth: GroundTruth, result: AnalysisResult): SlashMetrics {
  let slashSec = 0;
  let bassHit = 0;
  let displayHit = 0;
  let allSec = 0;
  let allDisplayHit = 0;
  const segs = result.segments;
  let segIdx = 0;
  for (const gt of truth.segments) {
    const bassPc = (gt as { bassPc?: number }).bassPc;
    const rootPc = parseChord(gt.chord)?.root;
    const isSlash = bassPc !== undefined && rootPc !== undefined && bassPc !== rootPc;
    const base = gt.fullChord ?? gt.chord;
    const expected = normalizeDisplayName(
      isSlash ? `${base}/${(gt as { bass?: string }).bass}` : base,
    );
    for (let t = gt.startSec; t < gt.endSec; t += SLASH_STEP) {
      const mid = t + SLASH_STEP / 2;
      while (segIdx < segs.length - 1 && mid >= segs[segIdx].end) segIdx++;
      const det =
        segs[segIdx] && mid >= segs[segIdx].start && mid < segs[segIdx].end
          ? segs[segIdx]
          : null;
      allSec += SLASH_STEP;
      if (det && normalizeDisplayName(displaySegmentChord(det)) === expected) {
        allDisplayHit += SLASH_STEP;
        if (isSlash) displayHit += SLASH_STEP;
      }
      if (isSlash) {
        slashSec += SLASH_STEP;
        if (det && det.bassPc === bassPc) bassHit += SLASH_STEP;
      }
    }
  }
  return {
    slashSec,
    bassAccuracyOnSlash: slashSec > 0 ? bassHit / slashSec : null,
    displayAgreementOnSlash: slashSec > 0 ? displayHit / slashSec : null,
    displayAgreementAll: allSec > 0 ? allDisplayHit / allSec : null,
  };
}

// ---------------------------------------------------------------------------
// 合成スイート（混合音）
// ---------------------------------------------------------------------------

export interface SyntheticArmResult {
  core: SongMeasurement;
  ext: ExtensionMeasurement;
  slash: SlashMetrics;
}

export interface SyntheticEntry {
  songId: string;
  title: string;
  arms: Record<string, SyntheticArmResult>;
}

const ALL_SPECS: SongSpec[] = [
  ...SONGS,
  ...SLASH_SONGS,
  ...SEVENTH_SONGS,
  ...SECONDARY_DOMINANT_SONGS,
  ...ADD9_SONGS,
  ...BLUES_SONGS,
  ...ROCK_SONGS,
];

export async function runIntegrationSynthetic(
  arms: ArmDef[] = ARMS,
): Promise<SyntheticEntry[]> {
  mkdirSync(TEST_AUDIO_DIR, { recursive: true });
  const entries: SyntheticEntry[] = [];
  for (const spec of ALL_SPECS) {
    const { samples, truth } = synthSong(spec, SAMPLE_RATE);
    const wavPath = join(TEST_AUDIO_DIR, `${spec.id}.wav`);
    const gtPath = join(TEST_AUDIO_DIR, `${spec.id}.groundtruth.json`);
    writeWav16(wavPath, samples, SAMPLE_RATE);
    writeFileSync(gtPath, JSON.stringify(truth, null, 2) + "\n", "utf-8");
    const wav = readWav16(wavPath);
    const notes = loadNotes(`${spec.id}.bp.json`);
    const noteEvidence: NoteEvidenceInput = { harmony: notes };

    const extTruth: ExtensionTruthSegment[] = truth.segments.flatMap((s) => {
      const label = truthLabelFromSynthetic(s);
      return label
        ? [{ startSec: s.startSec, endSec: s.endSec, label: s.fullChord ?? s.chord, truth: label }]
        : [];
    });

    const armResults: Record<string, SyntheticArmResult> = {};
    for (const arm of arms) {
      const result = await analyzeAudio(wav.samples, wav.sampleRate, `${spec.id}.wav`, undefined, {
        ...arm.options,
        noteEvidence,
      });
      armResults[arm.id] = {
        core: measureSong(truth, result),
        ext: measureExtensions(extTruth, truth.durationSec, result),
        slash: slashMetrics(truth, result),
      };
    }
    entries.push({ songId: spec.id, title: spec.title, arms: armResults });
    console.log(`synthetic ${spec.id} done`);
  }
  writeResults("synthetic", { synthetic: entries });
  return entries;
}

// ---------------------------------------------------------------------------
// 実曲（ステム／混合音）
// ---------------------------------------------------------------------------

export interface RealArmResult {
  core: RealSongMeasurement;
  ext: ExtensionMeasurement;
  maj7: { total: number; byChord: Record<string, number> };
  /** 正解が G メジャー三和音の区間に GM7 が付いた秒数 */
  gm7FalseFireSec: number;
}

/** 正解 G 三和音区間での GM7 誤発火秒数（10ms サンプリング） */
export function gm7FalseFireSec(truth: RealTruth, result: AnalysisResult): number {
  let sec = 0;
  const segs = result.segments;
  let segIdx = 0;
  for (const gt of truth.segments) {
    if (gt.chord !== "G") continue;
    for (let t = gt.startSec; t < gt.endSec; t += 0.01) {
      const mid = t + 0.005;
      while (segIdx < segs.length - 1 && mid >= segs[segIdx].end) segIdx++;
      const det =
        segs[segIdx] && mid >= segs[segIdx].start && mid < segs[segIdx].end
          ? segs[segIdx]
          : null;
      if (det && det.chord === "G" && det.extension === "maj7") sec += 0.01;
    }
  }
  return Number(sec.toFixed(2));
}

export interface RealEntry {
  slug: string;
  title: string;
  path: "stems" | "mixture";
  arms: Record<string, RealArmResult>;
}

const REAL_SLUGS = ["put-your-records-on", "everything", "a-hard-days-night"];

function extTruthFromReal(truth: RealTruth): ExtensionTruthSegment[] {
  return truth.segments.flatMap((s) => {
    const label = truthLabelFromFullName(s.chord);
    return label
      ? [{ startSec: s.startSec, endSec: s.endSec, label: s.chord, truth: label }]
      : [];
  });
}

export async function runIntegrationRealStems(
  arms: ArmDef[] = ARMS,
): Promise<RealEntry[]> {
  const entries: RealEntry[] = [];
  for (const slug of REAL_SLUGS) {
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
    const noteEvidence: NoteEvidenceInput = {
      harmony: loadNotes(`${slug}-other.bp.json`),
      bass: loadNotes(`${slug}-bass.bp.json`),
      // v2 証人の二重確認プール（混合音の音符列）
      corroboration: loadNotes(`${slug}-mix.bp.json`),
    };

    const chromas = prepareStemChromas(mix.samples, other.samples, bass.samples, sr);
    const armResults: Record<string, RealArmResult> = {};
    for (const arm of arms) {
      const result = analyzeStemsWithStrategy(chromas, sr, slug, "s-conditional", {
        ...arm.options,
        noteEvidence,
      });
      armResults[arm.id] = {
        core: measureRealSong(truth, result, `stems-${arm.id}`),
        ext: measureExtensions(extTruth, truth.durationSec, result),
        maj7: maj7Seconds(result),
        gm7FalseFireSec: gm7FalseFireSec(truth, result),
      };
    }
    entries.push({ slug, title: spec.title, path: "stems", arms: armResults });
    console.log(`real-stems ${slug} done`);
    writeResults("real-stems", { realStems: entries });
  }
  return entries;
}

export async function runIntegrationRealMixture(
  arms: ArmDef[] = ARMS,
): Promise<RealEntry[]> {
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
    const noteEvidence: NoteEvidenceInput = {
      harmony: loadNotes(`${slug}-mix.bp.json`),
    };

    const armResults: Record<string, RealArmResult> = {};
    for (const arm of arms) {
      const result = await analyzeAudio(mix.samples, mix.sampleRate, spec.mixPath, undefined, {
        ...arm.options,
        noteEvidence,
      });
      armResults[arm.id] = {
        core: measureRealSong(truth, result, `mix-${arm.id}`),
        ext: measureExtensions(extTruth, truth.durationSec, result),
        maj7: maj7Seconds(result),
        gm7FalseFireSec: gm7FalseFireSec(truth, result),
      };
    }
    entries.push({ slug, title: spec.title, path: "mixture", arms: armResults });
    console.log(`real-mixture ${slug} done`);
    writeResults("real-mixture", { realMixture: entries });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Suno 05 フィクスチャ
// ---------------------------------------------------------------------------

export interface SunoArmFixtures {
  q1: {
    range: [number, number];
    dominant: { chord: string; extension?: string; bassPc?: number; sec: number } | null;
    bassCorrect: boolean;
  }[];
  q4: {
    dominant: { chord: string; extension?: string; bassPc?: number; sec: number } | null;
    bassCorrect: boolean;
    display: string | null;
  };
  q3: { range: [number, number]; expected: string; label: string | null; pass: boolean }[];
  q2CmSec: number;
}

const Q3_SLICES: { range: [number, number]; expected: string; accept: string[] }[] = [
  { range: [85, 87], expected: "C", accept: ["C", "CM7"] },
  { range: [87, 89], expected: "B7", accept: ["B7"] },
  { range: [89, 91], expected: "E7", accept: ["E7"] },
  { range: [91, 93], expected: "Am", accept: ["Am", "Am7"] },
];

export function sunoFixtures(result: AnalysisResult): SunoArmFixtures {
  const q1Ranges: [number, number][] = [
    [51, 56],
    [93, 98],
  ];
  const q1 = q1Ranges.map((range) => {
    const dominant = dominantSegment(result, range[0], range[1]);
    return { range, dominant, bassCorrect: dominant?.bassPc === 2 };
  });
  const q4Dominant = dominantSegment(result, 62, 65);
  // 窓と最も長く重なるセグメントの表示文字列（層表示を含む）
  let q4Seg: AnalysisResult["segments"][number] | null = null;
  let q4Best = -1;
  for (const s of result.segments) {
    const overlap = Math.min(s.end, 65) - Math.max(s.start, 62);
    if (overlap > q4Best) {
      q4Best = overlap;
      q4Seg = s;
    }
  }
  const q3 = Q3_SLICES.map((s) => {
    const label = dominantFullLabel(result, s.range[0], s.range[1])?.label ?? null;
    return {
      range: s.range,
      expected: s.expected,
      label,
      pass: label !== null && s.accept.includes(label),
    };
  });
  return {
    q1,
    q4: {
      dominant: q4Dominant,
      bassCorrect: q4Dominant?.bassPc === 1,
      display: q4Seg ? displaySegmentChord(q4Seg) : null,
    },
    q3,
    q2CmSec: cmTimeInWindow(result, 153, 168),
  };
}

export interface SunoEntry {
  arms: Record<
    string,
    { stems: SunoArmFixtures; mixture: SunoArmFixtures }
  >;
}

export async function runIntegrationSuno(arms: ArmDef[] = ARMS): Promise<SunoEntry> {
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
  const stemsNotes: NoteEvidenceInput = {
    harmony: loadNotes("suno05-other.bp.json"),
    bass: loadNotes("suno05-bass.bp.json"),
    // v2 証人の二重確認プール（混合音の音符列）
    corroboration: loadNotes("suno05-mix.bp.json"),
  };
  const mixNotes: NoteEvidenceInput = { harmony: loadNotes("suno05-mix.bp.json") };

  const out: SunoEntry = { arms: {} };
  for (const arm of arms) {
    const stemsResult = analyzeStemsWithStrategy(chromas, sr, "05.mp3", "s-conditional", {
      ...arm.options,
      noteEvidence: stemsNotes,
    });
    const mixResult = await analyzeAudio(mix.samples, sr, "05.mp3", undefined, {
      ...arm.options,
      noteEvidence: mixNotes,
    });
    out.arms[arm.id] = {
      stems: sunoFixtures(stemsResult),
      mixture: sunoFixtures(mixResult),
    };
    console.log(`suno arm ${arm.id} done`);
  }
  writeResults("suno", { suno: out });
  return out;
}

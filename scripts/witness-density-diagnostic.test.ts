/**
 * noteTension v2（棄権つき証人）の密度規則を導出するための診断。
 *
 * 前回（NOTEPITCH_INTEGRATION.md）の敗因: replace 型の証人は、
 * Basic Pitch の再現率が低い窓でも「7 度音の音符が無い」ことを
 * 反証として使ってしまい、曲1 の真の maj7 を構造的に否決した。
 * 本診断は、第2段のみ（ext）と replace 証人ありの2ランを同一の
 * 第1段セグメント列で比較し、判定が変わる／変わらないセグメント
 * ごとに「窓の音符密度」の候補指標を実測する。密度が高い窓でのみ
 * 証人に発言権を与える規則が、誤発火窓（曲3）と真陽性喪失窓（曲1）
 * を分離できるかを、分布で確認するのが目的。
 *
 * 実行: npx vitest run scripts/witness-density-diagnostic.test.ts
 * 生成物: measurements/notepitch/witness-density-diagnostic.json
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import { analyzeAudio } from "../src/analysis/analyze";
import {
  analyzeStemsWithStrategy,
  prepareStemChromas,
} from "../src/analysis/analyzeStems";
import { parseChordName } from "../src/analysis/bassCorrection";
import { segmentEvidence } from "../src/analysis/extensionDetection";
import {
  notePcCoverage,
  notePcShares,
  type NoteEvent,
} from "../src/analysis/noteEvidence";
import { NO_CHORD } from "../src/lib/notes";
import type { AnalysisResult, ChordSegment } from "../src/types";
import {
  truthLabelFromFullName,
  truthLabelFromSynthetic,
  type TruthLabel,
} from "./extensionScoring";
import { loadNotes } from "./measureNoteIntegration";
import {
  loadAudioFile,
  parseTruthJson,
  type RealTruth,
} from "./measureReal";
import { findStemWav, STEM_SONGS } from "./measureStems";
import {
  SECONDARY_DOMINANT_SONGS,
  SEVENTH_SONGS,
  synthSong,
  type GroundTruth,
} from "./synth";
import { readWav16, writeWav16 } from "./wav";

const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT_PATH = join(
  PROJECT_ROOT,
  "measurements",
  "notepitch",
  "witness-density-diagnostic.json",
);
const SAMPLE_RATE = 44100;

// ---------------------------------------------------------------------------
// 密度候補（窓内の音符列から計算できる量）
// ---------------------------------------------------------------------------

export interface DensityCandidates {
  /** 窓のうち何らかの音符が鳴っている時間の割合（和集合） */
  unionCoverage: number;
  /** 検出コードの三和音構成音が占める音符シェア合計 */
  triadShare: number;
  /** 三和音構成音の被覆率の最大値 */
  triadMaxCoverage: number;
  /** シェア 0.02 以上のピッチクラス数 */
  activePcs: number;
  /** 窓に重なる音符数 ÷ 窓の長さ（秒） */
  notesPerSec: number;
  /** 証人そのものが無い（音符が重ならない） */
  witnessNull: boolean;
}

function unionCoverage(notes: NoteEvent[], t0: number, t1: number): number {
  const dur = t1 - t0;
  if (dur <= 0) return 0;
  const ivs = notes
    .map((n) => [Math.max(n.start, t0), Math.min(n.end, t1)] as [number, number])
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0]);
  let covered = 0;
  let curS = -Infinity;
  let curE = -Infinity;
  for (const [s, e] of ivs) {
    if (s > curE) {
      if (curE > curS) covered += curE - curS;
      curS = s;
      curE = e;
    } else if (e > curE) {
      curE = e;
    }
  }
  if (curE > curS) covered += curE - curS;
  return Math.min(1, covered / dur);
}

export function densityCandidates(
  notes: NoteEvent[],
  t0: number,
  t1: number,
  root: number,
  mode: "major" | "minor",
): DensityCandidates {
  const shares = notePcShares(notes, t0, t1);
  const dur = Math.max(t1 - t0, 1e-9);
  const third = (root + (mode === "major" ? 4 : 3)) % 12;
  const fifth = (root + 7) % 12;
  if (!shares) {
    return {
      unionCoverage: 0,
      triadShare: 0,
      triadMaxCoverage: 0,
      activePcs: 0,
      notesPerSec: 0,
      witnessNull: true,
    };
  }
  const coverage = notePcCoverage(notes, t0, t1);
  let activePcs = 0;
  for (let p = 0; p < 12; p++) if (shares[p] >= 0.02) activePcs++;
  let count = 0;
  for (const n of notes) if (n.end > t0 && n.start < t1) count++;
  return {
    unionCoverage: unionCoverage(notes, t0, t1),
    triadShare: shares[root] + shares[third] + shares[fifth],
    triadMaxCoverage: Math.max(coverage[root], coverage[third], coverage[fifth]),
    activePcs,
    notesPerSec: count / dur,
    witnessNull: false,
  };
}

// ---------------------------------------------------------------------------
// セグメント単位の比較行
// ---------------------------------------------------------------------------

export interface DiagRow {
  source: string;
  start: number;
  end: number;
  dur: number;
  chord: string;
  truthLabel: string | null;
  truthExt: string | null;
  chromaExt: string | null;
  replaceExt: string | null;
  /** 判定クラス（下記 classify） */
  cls: string;
  /** 関係する 7 度音ピッチクラスの音符シェア（chroma 側→replace 側の順で関係する pc） */
  noteSharePc: number | null;
  /** 関係 pc のクロマ側シェア（実曲 stems のみ。第2段の証拠そのもの） */
  chromaSharePc: number | null;
  /** 関係 pc のクロマ側持続性（実曲 stems のみ） */
  chromaPersistencePc: number | null;
  /** 関係 pc の混合音プール（BP on mix）での音符シェア（実曲のみ） */
  mixNoteSharePc: number | null;
  density: DensityCandidates;
}

function labelMatches(
  seg: ChordSegment,
  truth: TruthLabel | null,
): boolean {
  if (!truth || truth.coreMode === null) return false;
  const p = parseChordName(seg.chord);
  if (!p) return false;
  return (
    p.root === truth.root &&
    p.mode === truth.coreMode &&
    (seg.extension ?? null) === truth.ext
  );
}

function seventhPcOfSeg(seg: ChordSegment): number | null {
  if (!seg.extension) return null;
  const p = parseChordName(seg.chord);
  if (!p) return null;
  return (p.root + (seg.extension === "maj7" ? 11 : 10)) % 12;
}

function classify(
  chromaSeg: ChordSegment,
  replaceSeg: ChordSegment,
  truth: TruthLabel | null,
): string {
  const chromaOk = labelMatches(chromaSeg, truth);
  const replaceOk = labelMatches(replaceSeg, truth);
  const same =
    chromaSeg.chord === replaceSeg.chord &&
    (chromaSeg.extension ?? null) === (replaceSeg.extension ?? null);
  if (same) {
    if (!chromaSeg.extension) return "NONE";
    return chromaOk ? "TP_KEEP" : "GF_KEEP";
  }
  if (chromaOk && !replaceOk) return "KILL";
  if (!chromaOk && replaceOk) return "ADD_OK";
  if (!chromaSeg.extension && replaceSeg.extension) return "ADD_BAD";
  return "CHANGED_BAD";
}

function majorityTruthReal(
  truth: RealTruth,
  t0: number,
  t1: number,
): { label: TruthLabel | null; name: string | null } {
  const acc = new Map<string, { label: TruthLabel | null; name: string; sec: number }>();
  for (let t = t0; t < t1; t += 0.05) {
    const mid = t + 0.025;
    const gt = truth.segments.find((s) => mid >= s.startSec && mid < s.endSec);
    if (!gt) continue;
    const key = gt.chord;
    const cur = acc.get(key) ?? {
      label: truthLabelFromFullName(gt.chord),
      name: gt.chord,
      sec: 0,
    };
    cur.sec += 0.05;
    acc.set(key, cur);
  }
  let best: { label: TruthLabel | null; name: string; sec: number } | null = null;
  for (const v of acc.values()) if (!best || v.sec > best.sec) best = v;
  return { label: best?.label ?? null, name: best?.name ?? null };
}

function majorityTruthSynthetic(
  truth: GroundTruth,
  t0: number,
  t1: number,
): { label: TruthLabel | null; name: string | null } {
  const acc = new Map<string, { label: TruthLabel | null; name: string; sec: number }>();
  for (let t = t0; t < t1; t += 0.05) {
    const mid = t + 0.025;
    const gt = truth.segments.find((s) => mid >= s.startSec && mid < s.endSec);
    if (!gt) continue;
    const name = gt.fullChord ?? gt.chord;
    const cur = acc.get(name) ?? {
      label: truthLabelFromSynthetic(gt),
      name,
      sec: 0,
    };
    cur.sec += 0.05;
    acc.set(name, cur);
  }
  let best: { label: TruthLabel | null; name: string; sec: number } | null = null;
  for (const v of acc.values()) if (!best || v.sec > best.sec) best = v;
  return { label: best?.label ?? null, name: best?.name ?? null };
}

function buildRows(
  source: string,
  chromaResult: AnalysisResult,
  replaceResult: AnalysisResult,
  notes: NoteEvent[],
  truthAt: (t0: number, t1: number) => { label: TruthLabel | null; name: string | null },
  extra?: (seg: ChordSegment, pc: number | null) => {
    chromaSharePc: number | null;
    chromaPersistencePc: number | null;
    mixNoteSharePc: number | null;
  },
): DiagRow[] {
  const rows: DiagRow[] = [];
  const a = chromaResult.segments;
  const b = replaceResult.segments;
  if (a.length !== b.length) {
    throw new Error(`${source}: 第1段セグメント数がラン間で一致しません`);
  }
  for (let i = 0; i < a.length; i++) {
    const seg = a[i];
    const rep = b[i];
    if (seg.edited || seg.chord === NO_CHORD) continue;
    const parsed = parseChordName(seg.chord);
    if (!parsed) continue;
    const { label, name } = truthAt(seg.start, seg.end);
    const cls = classify(seg, rep, label);
    if (cls === "NONE") continue; // 拡張が絡まないセグメントは対象外
    const pc = seventhPcOfSeg(seg) ?? seventhPcOfSeg(rep);
    const shares = notePcShares(notes, seg.start, seg.end);
    const ex = extra?.(seg, pc) ?? {
      chromaSharePc: null,
      chromaPersistencePc: null,
      mixNoteSharePc: null,
    };
    rows.push({
      source,
      start: Number(seg.start.toFixed(2)),
      end: Number(seg.end.toFixed(2)),
      dur: Number((seg.end - seg.start).toFixed(2)),
      chord: seg.chord + (seg.extension ?? ""),
      truthLabel: name,
      truthExt: label ? (label.ext ?? "none") : null,
      chromaExt: seg.extension ?? null,
      replaceExt: rep.extension ?? null,
      cls,
      noteSharePc: pc !== null && shares ? Number(shares[pc].toFixed(3)) : null,
      ...ex,
      density: densityCandidates(notes, seg.start, seg.end, parsed.root, parsed.mode),
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// 分布の要約
// ---------------------------------------------------------------------------

function summarize(rows: DiagRow[]): Record<string, unknown> {
  const byClass = new Map<string, DiagRow[]>();
  for (const r of rows) {
    const arr = byClass.get(r.cls) ?? [];
    arr.push(r);
    byClass.set(r.cls, arr);
  }
  const out: Record<string, unknown> = {};
  const keys: (keyof DensityCandidates)[] = [
    "unionCoverage",
    "triadShare",
    "triadMaxCoverage",
    "activePcs",
    "notesPerSec",
  ];
  for (const [cls, arr] of byClass) {
    const sec = arr.reduce((s, r) => s + r.dur, 0);
    const stats: Record<string, unknown> = { segments: arr.length, seconds: Number(sec.toFixed(1)) };
    for (const k of keys) {
      // 秒数で重み付けした分位点（各行を dur だけ複製した分布とみなす）
      const pts: [number, number][] = arr
        .map((r) => [r.density[k] as number, r.dur] as [number, number])
        .sort((x, y) => x[0] - y[0]);
      const total = pts.reduce((s, [, w]) => s + w, 0);
      const q = (f: number) => {
        let acc = 0;
        for (const [v, w] of pts) {
          acc += w;
          if (acc >= total * f) return Number(v.toFixed(3));
        }
        return Number((pts[pts.length - 1]?.[0] ?? 0).toFixed(3));
      };
      stats[k as string] = { min: q(0), p25: q(0.25), med: q(0.5), p75: q(0.75), max: q(1) };
    }
    out[cls] = stats;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 診断本体
// ---------------------------------------------------------------------------

describe("noteTension v2: 証人密度の診断", () => {
  it(
    "実曲 stems と合成 E/F でクラス別分布を実測する",
    async () => {
      const allRows: DiagRow[] = [];

      // 実曲 stems（主戦場）
      for (const slug of ["put-your-records-on", "everything", "a-hard-days-night"]) {
        const spec = STEM_SONGS.find((s) => s.slug === slug)!;
        const otherPath = findStemWav(spec.stemRoot, "other");
        const bassPath = findStemWav(spec.stemRoot, "bass");
        if (!otherPath || !bassPath) continue;
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
        const noteEvidence = {
          harmony: loadNotes(`${slug}-other.bp.json`),
          bass: loadNotes(`${slug}-bass.bp.json`),
        };
        const chromas = prepareStemChromas(mix.samples, other.samples, bass.samples, sr);
        const chromaRun = analyzeStemsWithStrategy(chromas, sr, slug, "s-conditional", {
          extensions: true,
        });
        const replaceRun = analyzeStemsWithStrategy(chromas, sr, slug, "s-conditional", {
          extensions: true,
          noteEvidence,
          noteTension: true,
          noteTensionMode: "replace",
        });
        const mixNotes = loadNotes(`${slug}-mix.bp.json`);
        const fd = chromas.otherChroma.frameDuration;
        const extra = (seg: ChordSegment, pc: number | null) => {
          if (pc === null) {
            return { chromaSharePc: null, chromaPersistencePc: null, mixNoteSharePc: null };
          }
          const startIdx = Math.floor(seg.start / fd);
          const endIdx = Math.max(startIdx + 1, Math.ceil(seg.end / fd));
          const ev = segmentEvidence(
            chromas.otherChroma.chordFrames,
            chromas.otherChroma.energies,
            startIdx,
            endIdx,
          );
          const mixShares = notePcShares(mixNotes, seg.start, seg.end);
          return {
            chromaSharePc: ev ? Number(ev.shares[pc].toFixed(3)) : null,
            chromaPersistencePc: ev ? Number(ev.persistence[pc].toFixed(3)) : null,
            mixNoteSharePc: mixShares ? Number(mixShares[pc].toFixed(3)) : null,
          };
        };
        allRows.push(
          ...buildRows(
            `real-stems:${slug}`,
            chromaRun,
            replaceRun,
            noteEvidence.harmony,
            (t0, t1) => majorityTruthReal(truth, t0, t1),
            extra,
          ),
        );
        console.log(`diagnostic real-stems ${slug} done`);
      }

      // 合成 E/F（混合音）
      for (const spec of [...SEVENTH_SONGS, ...SECONDARY_DOMINANT_SONGS]) {
        const { samples, truth } = synthSong(spec, SAMPLE_RATE);
        const wavPath = join(PROJECT_ROOT, "test-audio", `${spec.id}.wav`);
        writeWav16(wavPath, samples, SAMPLE_RATE);
        const wav = readWav16(wavPath);
        const notes = loadNotes(`${spec.id}.bp.json`);
        const chromaRun = await analyzeAudio(wav.samples, wav.sampleRate, spec.id, undefined, {
          extensions: true,
        });
        const replaceRun = await analyzeAudio(wav.samples, wav.sampleRate, spec.id, undefined, {
          extensions: true,
          noteEvidence: { harmony: notes },
          noteTension: true,
          noteTensionMode: "replace",
        });
        allRows.push(
          ...buildRows(`synthetic:${spec.id}`, chromaRun, replaceRun, notes, (t0, t1) =>
            majorityTruthSynthetic(truth, t0, t1),
          ),
        );
        console.log(`diagnostic synthetic ${spec.id} done`);
      }

      // Suno Q3 窓（85–93 秒、stems）: 正解ラベルは無いので判定変化だけ記録
      {
        const mixPath = join(homedir(), "workspace/user/files/05.mp3");
        const stemRoot = join(PROJECT_ROOT, "stem-work/suno-05");
        const otherPath = findStemWav(stemRoot, "other");
        const bassPath = findStemWav(stemRoot, "bass");
        if (otherPath && bassPath && existsSync(mixPath)) {
          const mix = loadAudioFile(mixPath);
          const other = loadAudioFile(otherPath);
          const bass = loadAudioFile(bassPath);
          const sr = mix.sampleRate;
          const noteEvidence = {
            harmony: loadNotes("suno05-other.bp.json"),
            bass: loadNotes("suno05-bass.bp.json"),
          };
          const chromas = prepareStemChromas(mix.samples, other.samples, bass.samples, sr);
          const chromaRun = analyzeStemsWithStrategy(chromas, sr, "05.mp3", "s-conditional", {
            extensions: true,
          });
          const replaceRun = analyzeStemsWithStrategy(chromas, sr, "05.mp3", "s-conditional", {
            extensions: true,
            noteEvidence,
            noteTension: true,
            noteTensionMode: "replace",
          });
          const q3Rows = buildRows("suno-q3", chromaRun, replaceRun, noteEvidence.harmony, () => ({
            label: null,
            name: null,
          })).filter((r) => r.end > 85 && r.start < 93);
          allRows.push(...q3Rows);
          console.log("diagnostic suno q3 done");
        }
      }

      const summary = summarize(allRows);
      writeFileSync(
        OUT_PATH,
        JSON.stringify({ summary, rows: allRows }, null, 2) + "\n",
        "utf-8",
      );
      console.log(JSON.stringify(summary, null, 2));
    },
    1_800_000,
  );
});

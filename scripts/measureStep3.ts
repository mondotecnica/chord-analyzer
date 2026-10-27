/**
 * Phase 1 Step 3（実曲測定）の測定ハーネス。
 *
 * 背景: 合成音源では上帯域 260Hz ハードカットが Song D 26.7% → 87.2%、
 * Songs A–C も 95.4%/86.4% → 96.9%/92.1% と改善した
 * （measurements/PHASE1_UPPERBAND.md）。ただし合成音源はコード楽器の
 * 基本波がすべて 261.6Hz 以上という一番易しい条件で、実曲では低音域で
 * コードを弾く楽器やボーカル・ドラムが混ざるため、この改善幅は上限値。
 * 実曲で同じ設定が勝つか、帯域の最適値が変わるかを、設定を固定で
 * 信じずに 4 設定の A/B 比較で確かめるのが Step 3。
 *
 * 比較する 4 設定（assistant が 2026-10-27 に提案した構成そのまま）:
 * 1. phase0: 全帯域・ベース補正なし（フェーズ0そのまま）
 * 2. bass-only: 全帯域・ベース補正あり
 * 3. current: ベース補正あり＋上帯域 260Hz ハードカット（現在の既定）
 * 4. cut220: ベース補正あり＋上帯域 220Hz ハードカット（境界の別バリアント）
 *
 * 入力:
 * - 音声: ffmpeg で 16-bit PCM WAV に変換したもの
 *   （例: ffmpeg -y -i song.mp3 -ac 1 -ar 44100 -sample_fmt s16 test-audio/step3-song.wav）
 *   MP3 を直接読むのではなく WAV 経由にするのは、既存の readWav16 が
 *   PCM 専用で、変換条件を明示して再現性を保つため。
 * - 正解進行: measurements/step3-truth-TEMPLATE.json と同じ形の JSON。
 *   コード名は major/minor の三和音（"C", "Am" など）。分数コードは
 *   "C/E" の形でも受け付け、ルート側を chord、ベース側を bass に分ける。
 *   テンション・7th を含む正解は Phase 0 の語彙外のため、Step 3 の対象は
 *   まず三和音中心の曲（または三和音コアで区切った区間）とする。
 *
 * 出力: runStep3FromFiles の outPath に JSON を書き出す。
 * 解析アルゴリズム自体には一切手を入れない（測定専用）。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeAudio, type AnalyzeOptions } from "../src/analysis/analyze";
import type { ChromaBandOptions } from "../src/dsp/chroma";
import { NOTE_NAMES } from "../src/lib/notes";
import { measureSong, type SongMeasurement } from "./measureSynthetic";
import type { GroundTruth } from "./synth";
import { readWav16 } from "./wav";

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MEASUREMENTS_DIR = join(PROJECT_ROOT, "measurements");

export interface Step3Variant {
  id: string;
  label: string;
  options: AnalyzeOptions;
}

export const STEP3_VARIANTS: Step3Variant[] = [
  {
    id: "phase0",
    label: "フェーズ0そのまま（全帯域・補正なし）",
    options: { bassCorrection: false, chordBand: null, bandStrategy: "unified" },
  },
  {
    id: "bass-only",
    label: "＋ベース補正（全帯域）",
    options: { bassCorrection: true, chordBand: null, bandStrategy: "unified" },
  },
  {
    id: "current",
    label: "＋上帯域260Hzカット（旧既定＝unified、計画時点の「現在の既定」）",
    options: {
      bassCorrection: true,
      chordBand: { cutoffHz: 260, belowWeight: 0 } satisfies ChromaBandOptions,
      bandStrategy: "unified",
    },
  },
  {
    id: "cut220",
    label: "上帯域220Hzカット（境界の別バリアント）",
    options: {
      bassCorrection: true,
      chordBand: { cutoffHz: 220, belowWeight: 0 } satisfies ChromaBandOptions,
      bandStrategy: "unified",
    },
  },
];

export interface Step3VariantResult {
  variant: Step3Variant;
  measurement: SongMeasurement;
}

export interface Step3Result {
  songId: string;
  title: string;
  variants: Step3VariantResult[];
}

interface TruthJsonSegment {
  startSec: number;
  endSec: number;
  chord: string;
  bass?: string;
}

interface TruthJson {
  songId: string;
  title: string;
  key: string;
  bpm: number;
  sampleRate?: number;
  durationSec: number;
  segments: TruthJsonSegment[];
}

/** "C/E" を { chord: "C", bass: "E" } に、"Am" を { chord: "Am" } に分ける。 */
export function splitSlashChord(raw: string): { chord: string; bass?: string } {
  const [chord, bass] = raw.split("/");
  return bass ? { chord, bass } : { chord };
}

function chordRootPc(chord: string): number {
  const name = chord.endsWith("m") ? chord.slice(0, -1) : chord;
  const pc = NOTE_NAMES.indexOf(name as (typeof NOTE_NAMES)[number]);
  if (pc < 0) throw new Error(`未知のコード名: ${chord}`);
  return pc;
}

/** 正解進行 JSON をハーネス共通の GroundTruth 形に変換する。 */
export function parseStep3Truth(json: unknown): GroundTruth {
  const t = json as TruthJson;
  if (!t || typeof t.songId !== "string" || !Array.isArray(t.segments)) {
    throw new Error("正解進行 JSON の形が不正です（songId / segments が必要）");
  }
  const segments = t.segments.map((s) => {
    const { chord, bass } = splitSlashChord(s.chord);
    const rootPc = chordRootPc(chord);
    const bassName = bass ?? s.bass ?? chord.replace(/m$/, "");
    // ベース名が "E" のような音名でない場合はルート音名にフォールバック
    const bassPcRaw = NOTE_NAMES.indexOf(bassName as (typeof NOTE_NAMES)[number]);
    const bassPc = bassPcRaw >= 0 ? bassPcRaw : rootPc;
    const bassDisplay =
      bassPcRaw >= 0 ? bassName : NOTE_NAMES[rootPc];
    return {
      startSec: s.startSec,
      endSec: s.endSec,
      chord,
      bass: bassDisplay,
      bassPc,
    };
  });
  return {
    songId: t.songId,
    title: t.title,
    key: t.key,
    bpm: t.bpm,
    sampleRate: t.sampleRate ?? 44100,
    durationSec: t.durationSec,
    segments,
  };
}

export async function runStep3Measurement(
  samples: Float32Array,
  sampleRate: number,
  truth: GroundTruth,
  outPath?: string,
): Promise<Step3Result> {
  const variants: Step3VariantResult[] = [];
  for (const variant of STEP3_VARIANTS) {
    const result = await analyzeAudio(
      samples,
      sampleRate,
      `${truth.songId}.wav`,
      undefined,
      variant.options,
    );
    variants.push({ variant, measurement: measureSong(truth, result) });
  }
  const step3: Step3Result = { songId: truth.songId, title: truth.title, variants };
  if (outPath) {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(step3, null, 2));
  }
  return step3;
}

/** WAV ファイル＋正解進行 JSON から Step 3 を実行する（実曲用エントリ）。 */
export async function runStep3FromFiles(
  wavPath: string,
  truthPath: string,
  outPath: string,
): Promise<Step3Result> {
  const wav = readWav16(wavPath);
  const truth = parseStep3Truth(JSON.parse(readFileSync(truthPath, "utf-8")));
  return runStep3Measurement(wav.samples, wav.sampleRate, truth, outPath);
}

export const STEP3_MEASUREMENTS_DIR = MEASUREMENTS_DIR;

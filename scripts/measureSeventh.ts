/**
 * Phase 3.1 の測定土台：7th コード合成曲（Song E）のベースライン測定。
 *
 * 目的は 3.1 の実装前の「ビフォア」数値を固定すること。
 * - 解析アルゴリズム自体には一切手を入れない（測定専用）。
 * - 解析はアプリの現行既定（bandStrategy "split"、ベース補正あり）で行う。
 *   Phase 0 ベースライン（measureSynthetic.ts）が Phase 0 パイプライン固定なのとは
 *   対照的に、こちらは「今日のアプリが 7th 曲に何を出すか」を測る。
 * - 正解セグメントの chord は三和音コアなので、既存の measureSong が出す
 *   ルート／三和音正解率はそのまま「コア正解率」として読める。
 *   7th を含む完全正解（fullChord）に対しては、現行語彙に 7th が無いため
 *   完全正解率は構造的に 0% になる。その代わり小節ごとの検出ラベルを
 *   並べ、3.1 で直すべき具体的な誤読（例：実曲 Q3 の B7→A 型）を可視化する。
 *
 * 生成物:
 * - test-audio/song-e.wav と song-e.groundtruth.json
 * - measurements/PHASE3_SONG_E_BASELINE.md / song-e-results.json
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeAudio } from "../src/analysis/analyze";
import { measureSong, type SongMeasurement } from "./measureSynthetic";
import { SEVENTH_SONGS, synthSong } from "./synth";
import { readWav16, writeWav16 } from "./wav";

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TEST_AUDIO_DIR = join(PROJECT_ROOT, "test-audio");
const MEASUREMENTS_DIR = join(PROJECT_ROOT, "measurements");
const SAMPLE_RATE = 44100;

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

function buildReport(measurements: SongMeasurement[]): string {
  const today = new Date().toISOString().slice(0, 10);
  const lines: string[] = [];
  lines.push("# Phase 3.1 測定土台 — 7th コード合成曲（Song E）ベースライン");
  lines.push("");
  lines.push(`測定日: ${today} / ハーネス: scripts/measureSeventh.ts`);
  lines.push("");
  lines.push("## 位置づけ");
  lines.push("");
  lines.push("- PHASE3_PLAN.md §3.1（7th／テンション二段判定）の実装前に、現行アプリの");
  lines.push("  「ビフォア」数値を固定するための測定。解析ロジックには手を入れていない。");
  lines.push("- 解析条件はアプリの現行既定（bandStrategy \"split\"、ベース補正あり）。");
  lines.push("  Phase 0 ベースライン（Phase 0 パイプライン固定）とは条件が違うため、");
  lines.push("  数値を直接並べての優劣比較はしないこと。");
  lines.push("- 正解の chord は三和音コア、fullChord が 7th を含む完全正解。");
  lines.push("  現行語彙に 7th が無いため、完全正解率は構造的に 0% である。");
  lines.push("  3.1 の合格基準は (a) コア正解率がここから下がらないこと、");
  lines.push("  (b) 完全正解率が上がること（特に下表の Q3 型の小節）の 2 本立て。");
  lines.push("");
  lines.push("## 結果サマリ");
  lines.push("");
  lines.push("| 曲 | 長さ | キー（正解 → 検出） | BPM（正解 → 推定） | コア：ルート正解率 | コア：三和音正解率 | N.C. 割合 |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const msr of measurements) {
    const t = msr.truth;
    lines.push(
      `| ${t.title} | ${msr.durationSec.toFixed(1)}秒 | ${t.key} → ${msr.detectedKey} | ${t.bpm} → ${msr.detectedBpm ?? "—"} | ${pct(msr.rootAccuracy)} | ${pct(msr.triadAccuracy)} | ${pct(msr.ncShare)} |`,
    );
  }
  lines.push("");
  lines.push("## 小節ごとの正解と検出（Song E）");
  lines.push("");
  lines.push("| 小節 | 時間 | 完全正解 | コア | 検出（現行アプリ） | 信頼度 |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const msr of measurements) {
    for (const seg of msr.truth.segments) {
      const mid = (seg.startSec + seg.endSec) / 2;
      const det = msr.detectedSegments.find(
        (s) => mid >= s.startSec && mid < s.endSec,
      );
      lines.push(
        `| ${msr.truth.segments.indexOf(seg) + 1} | ${seg.startSec.toFixed(2)}–${seg.endSec.toFixed(2)}秒 | ${seg.fullChord ?? seg.chord} | ${seg.chord} | ${det?.chord ?? "—"} | ${det?.confidence ?? "—"} |`,
      );
    }
  }
  lines.push("");
  lines.push("## 主な取り違え（コア基準）");
  for (const msr of measurements) {
    if (msr.confusions.length === 0 && msr.ncShare === 0) {
      lines.push("- 取り違え・N.C. 区間はなし。");
    } else {
      for (const c of msr.confusions) {
        lines.push(`- ${c.gt} → ${c.det}: ${c.sec.toFixed(2)}秒`);
      }
      if (msr.ncShare > 0) lines.push(`- N.C.（無判定）: 全体の ${pct(msr.ncShare)}`);
    }
  }
  lines.push("");
  lines.push("## 3.1 への含意");
  lines.push("");
  lines.push("- 上表で 7th 音が検出ラベルに現れないのは語彙の欠如そのものであり、");
  lines.push("  故障ではない。3.1 はコア判定を壊さずにこの列を埋めることが仕事。");
  lines.push("- 実曲 Q3（CM7–B7–E7–Am）と同じ並びを小節 1–4 に置いてあるため、");
  lines.push("  合成曲での B7 の読みと実曲での B7→A の誤読を突き合わせられる。");
  lines.push("");
  return lines.join("\n");
}

export async function runSeventhMeasurement(): Promise<SongMeasurement[]> {
  mkdirSync(TEST_AUDIO_DIR, { recursive: true });
  mkdirSync(MEASUREMENTS_DIR, { recursive: true });

  const measurements: SongMeasurement[] = [];
  for (const spec of SEVENTH_SONGS) {
    const { samples, truth } = synthSong(spec, SAMPLE_RATE);
    const wavPath = join(TEST_AUDIO_DIR, `${spec.id}.wav`);
    const gtPath = join(TEST_AUDIO_DIR, `${spec.id}.groundtruth.json`);
    writeWav16(wavPath, samples, SAMPLE_RATE);
    writeFileSync(gtPath, JSON.stringify(truth, null, 2) + "\n", "utf-8");

    const wav = readWav16(wavPath);
    // 既定＝今日のアプリの動作（bandStrategy "split"、ベース補正あり）
    const result = await analyzeAudio(wav.samples, wav.sampleRate, `${spec.id}.wav`);
    measurements.push(measureSong(truth, result));
  }

  writeFileSync(
    join(MEASUREMENTS_DIR, "PHASE3_SONG_E_BASELINE.md"),
    buildReport(measurements),
    "utf-8",
  );
  writeFileSync(
    join(MEASUREMENTS_DIR, "song-e-results.json"),
    JSON.stringify(measurements, null, 2) + "\n",
    "utf-8",
  );
  return measurements;
}

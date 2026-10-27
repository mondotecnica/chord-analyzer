/**
 * Phase 1 Step 2 の測定ハーネス: 分数コード（スラッシュコード）対応の検証。
 *
 * 1. Song D（分数コード進行 C/E–F/A–G/B–Am/E）を test-audio/ に生成し、
 *    正解 JSON（ルートとベース音を別フィールドで保持）と併せて保存する。
 * 2. 解析パイプライン（ベース補正あり）で解析し、ACCURACY_MEASUREMENT.md の
 *    定義でルート／三和音正解率を測る（measureSynthetic.measureSong を再利用）。
 * 3. 分数表示の正しさを 10ms 刻みの時刻軸突き合わせで測る:
 *    - 正解が分数表示になる時間のうち、検出表示が一致した割合（slashAccuracy）
 *    - 正解が通常表示の時間に、検出が分数表示になってしまった時間（spuriousSlashSec）
 * 4. 回帰確認: Songs A–C（ベースは常にルート）にベース補正を適用し、
 *    Step 1 の記録（ルート 95.4% / 三和音 86.4%）と変わらないこと、
 *    分数表示が一切出ないことを確認する。
 *
 * 出力: measurements/PHASE1_STEP2.md / measurements/phase1-step2-results.json
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeAudio } from "../src/analysis/analyze";
import { displayChordName } from "../src/lib/chordDisplay";
import { NO_CHORD, noteName } from "../src/lib/notes";
import type { AnalysisResult, ChordSegment } from "../src/types";
import { measureSong, type SongMeasurement } from "./measureSynthetic";
import { SONGS, SLASH_SONGS, synthSong, type GroundTruth } from "./synth";
import { readWav16, writeWav16 } from "./wav";

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TEST_AUDIO_DIR = join(PROJECT_ROOT, "test-audio");
const MEASUREMENTS_DIR = join(PROJECT_ROOT, "measurements");
const SAMPLE_RATE = 44100;
const STEP = 0.01;

export interface SlashMetrics {
  /** 正解が分数表示になる時間（秒） */
  slashExpectedSec: number;
  /** そのうち検出表示が正解表示と一致した時間（秒） */
  slashCorrectSec: number;
  /** slashCorrectSec / slashExpectedSec */
  slashAccuracy: number;
  /** 正解が通常表示の時間（秒） */
  plainExpectedSec: number;
  /** 正解が通常表示なのに検出が分数表示になった時間（秒） */
  spuriousSlashSec: number;
  /** 検出セグメントの表示名一覧（レポート用） */
  detectedDisplaySegments: {
    startSec: number;
    endSec: number;
    chord: string;
    bass?: string;
    display: string;
  }[];
}

export interface Step2Result {
  songD: {
    measurement: SongMeasurement;
    slash: SlashMetrics;
  };
  regression: {
    songs: SongMeasurement[];
    rootAccuracy: number;
    triadAccuracy: number;
    spuriousSlashSec: number;
  };
}

/** 正解と検出結果から分数表示の指標を 10ms 刻みで集計する */
export function measureSlash(truth: GroundTruth, result: AnalysisResult): SlashMetrics {
  const total = truth.durationSec;
  let slashExpected = 0;
  let slashCorrect = 0;
  let plainExpected = 0;
  let spurious = 0;

  let segIdx = 0;
  const segs = result.segments;
  for (let t = 0; t < total; t += STEP) {
    const mid = t + STEP / 2;
    const gtSeg = truth.segments.find((s) => mid >= s.startSec && mid < s.endSec);
    if (!gtSeg) continue;
    while (segIdx < segs.length - 1 && mid >= segs[segIdx].end) segIdx++;
    const det =
      segs[segIdx] && mid >= segs[segIdx].start && mid < segs[segIdx].end
        ? segs[segIdx]
        : null;

    const expectedDisplay = displayChordName(gtSeg.chord, gtSeg.bassPc);
    const detDisplay = det ? displayChordName(det.chord, det.bassPc) : NO_CHORD;

    if (expectedDisplay.includes("/")) {
      slashExpected += STEP;
      if (detDisplay === expectedDisplay) slashCorrect += STEP;
    } else {
      plainExpected += STEP;
      if (detDisplay.includes("/")) spurious += STEP;
    }
  }

  return {
    slashExpectedSec: slashExpected,
    slashCorrectSec: slashCorrect,
    slashAccuracy: slashExpected > 0 ? slashCorrect / slashExpected : 0,
    plainExpectedSec: plainExpected,
    spuriousSlashSec: spurious,
    detectedDisplaySegments: segs
      .filter((s) => s.start < total)
      .map((s: ChordSegment) => ({
        startSec: Number(s.start.toFixed(2)),
        endSec: Number(Math.min(s.end, total).toFixed(2)),
        chord: s.chord,
        ...(s.bassPc !== undefined ? { bass: noteName(s.bassPc) } : {}),
        display: displayChordName(s.chord, s.bassPc),
      })),
  };
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

function buildReport(result: Step2Result): string {
  const today = new Date().toISOString().slice(0, 10);
  const { measurement: d, slash } = result.songD;
  const reg = result.regression;
  const lines: string[] = [];
  lines.push("# Phase 1 Step 2 測定結果 — 分数コード（スラッシュコード）対応");
  lines.push("");
  lines.push(`測定日: ${today} / ハーネス: scripts/measurePhase1Step2.ts（\`npm run measure:phase1-step2\` で再実行可能）`);
  lines.push("");
  lines.push("## 実施内容");
  lines.push("");
  lines.push("- `scripts/synth.ts`: 進行の各コードに `bassPc`（ルートと別のベース音）を");
  lines.push("  指定できるよう拡張。正解 JSON の各セグメントにも `bass` / `bassPc` を");
  lines.push("  ルートとは別フィールドで記録するようにした（A–C はベース=ルートで不変）。");
  lines.push("- `src/lib/chordDisplay.ts`（新規）: 表示名を組み立てる純粋関数");
  lines.push("  `displayChordName(chord, bassPc)`。ベース=ルートなら通常表示、");
  lines.push("  ベースが 3rd / 5th の構成音なら分数表示（C/E 等）、構成音でなければ");
  lines.push("  通常表示のまま。React UI（タイムライン／一覧／再生中のコード）、");
  lines.push("  テキスト譜の書き出しに適用。JSON 書き出しは chord と bass を");
  lines.push("  別フィールドのまま保持し、分数表記は保存しない。");
  lines.push("- `src/analysis/bassCorrection.ts`: Step 1 の補正が分数コードを壊さないよう");
  lines.push("  ゲートを追加。ベース音が検出コードの構成音の場合は分数コードの可能性が");
  lines.push("  高いため、候補コード（ルート=ベース音）のクロマスコアが検出コードの");
  lines.push("  スコア − 0.08 以内の場合に限って補正する。それ以外はルートを変えず");
  lines.push("  bassPc だけを残す。構成音でないベース音は従来通り補正する。");
  lines.push("");
  lines.push("  ゲートの実測根拠（合成 4 曲、候補スコア − 検出スコア）:");
  lines.push("  補正が必要な相対調ケース（Am → C ×5件）は −0.041 以上、");
  lines.push("  補正してはいけない分数ケース（C/E、F/A 等）は −0.144 以下だったため、");
  lines.push("  ほぼ中間の 0.08 をしきい値に採用した。");
  lines.push("");
  lines.push("## Song D の仕様");
  lines.push("");
  lines.push(`- ${d.truth.title} / キー ${d.truth.key} / ${d.truth.bpm} BPM / ${d.durationSec.toFixed(1)}秒`);
  lines.push("- 進行（各 1 小節 × 2 周）:");
  for (const s of d.truth.segments.slice(0, 4)) {
    lines.push(`  - ${s.chord}（ベース ${s.bass}）→ 表示 ${displayChordName(s.chord, s.bassPc)}`);
  }
  lines.push("");
  lines.push("## Song D の結果");
  lines.push("");
  lines.push("| 指標 | 結果 |");
  lines.push("| --- | --- |");
  lines.push(`| ルート正解率 | ${pct(d.rootAccuracy)} |`);
  lines.push(`| 三和音正解率 | ${pct(d.triadAccuracy)} |`);
  lines.push(`| N.C. 割合 | ${pct(d.ncShare)} |`);
  lines.push(`| キー検出 | ${d.truth.key} → ${d.detectedKey}${d.truth.key === d.detectedKey ? " ✓" : " ✗"} |`);
  lines.push(`| BPM 推定 | ${d.truth.bpm} → ${d.detectedBpm ?? "—"} |`);
  lines.push(`| 分数表示の正しさ（正解が分数の時間のうち表示一致） | ${pct(slash.slashAccuracy)}（${slash.slashCorrectSec.toFixed(2)}秒 / ${slash.slashExpectedSec.toFixed(2)}秒） |`);
  lines.push(`| 誤った分数表示（正解が通常表示の時間に出た分数表示） | ${slash.spuriousSlashSec.toFixed(2)}秒 |`);
  lines.push("");
  lines.push("検出セグメント（表示名つき）:");
  for (const s of slash.detectedDisplaySegments) {
    lines.push(`- ${s.startSec.toFixed(2)}–${s.endSec.toFixed(2)}秒: ${s.display}`);
  }
  lines.push("");
  if (d.confusions.length > 0) {
    lines.push("主な取り違え（正解 → 検出、秒数）:");
    for (const c of d.confusions) {
      lines.push(`- ${c.gt} → ${c.det}: ${c.sec.toFixed(2)}秒`);
    }
    lines.push("");
  }
  lines.push("## 回帰確認（Songs A–C、ベース補正あり）");
  lines.push("");
  lines.push("| 指標 | Step 1 の記録 | Step 2 適用後 |");
  lines.push("| --- | --- | --- |");
  lines.push(`| ルート正解率 | 95.4% | ${pct(reg.rootAccuracy)} |`);
  lines.push(`| 三和音正解率 | 86.4% | ${pct(reg.triadAccuracy)} |`);
  lines.push(`| 誤った分数表示の合計 | 0.00秒（分数表示なし） | ${reg.spuriousSlashSec.toFixed(2)}秒 |`);
  lines.push("");
  for (const s of reg.songs) {
    lines.push(`- ${s.truth.title}: ルート ${pct(s.rootAccuracy)} / 三和音 ${pct(s.triadAccuracy)}`);
  }
  lines.push("");
  lines.push("## 制限と所見");
  lines.push("");
  lines.push("- Song D の誤りの中心は分数表示以前の Phase 0 のルート誤りである。");
  lines.push("  ベースが構成音を強く鳴らす条件では、そのピッチクラスが全帯域クロマを");
  lines.push("  引っ張り、ルート自体の検出が崩れやすい（例: Am/E の小節が Dm と検出される）。");
  lines.push("  分数表示は「ルートが正しく検出できたセグメント」でのみ効く仕組みであり、");
  lines.push("  このクラスは Phase 2（ステム分離でベースとコード楽器を分けて見る）の");
  lines.push("  改善対象と考える。");
  lines.push("- ベース音が構成音でない場合は、設計通り分数表示にせず通常表示のままに");
  lines.push("  している（Step 1 のルート補正の領域であり、表示側では新挙動を作らない）。");
  lines.push("- ゲートのしきい値（0.08）は合成 4 曲の実測に基づく。実曲のベースは");
  lines.push("  もっと曖昧なため、Step 3（実曲測定）で再確認が必要。");
  lines.push("- 合成音源はベースが拍頭で明快な条件であり、数字は上限値として読むこと。");
  lines.push("  Phase 1 の完了判定は Step 3（実曲 3 曲の測定）を経てから行う。");
  lines.push("");
  return lines.join("\n");
}

export async function runPhase1Step2Measurement(): Promise<Step2Result> {
  mkdirSync(TEST_AUDIO_DIR, { recursive: true });
  mkdirSync(MEASUREMENTS_DIR, { recursive: true });

  // --- Song D ---
  const specD = SLASH_SONGS[0];
  const { samples, truth } = synthSong(specD, SAMPLE_RATE);
  const wavPathD = join(TEST_AUDIO_DIR, `${specD.id}.wav`);
  const gtPathD = join(TEST_AUDIO_DIR, `${specD.id}.groundtruth.json`);
  writeWav16(wavPathD, samples, SAMPLE_RATE);
  writeFileSync(gtPathD, JSON.stringify(truth, null, 2) + "\n", "utf-8");
  const wavD = readWav16(wavPathD);
  // 上帯域クロマ（chordBand）は Step 2 測定の対象外なので null で固定し、
  // この履歴測定の再現性を保つ（対策の測定は measureUpperBand.ts が担う）。
  const resultD = await analyzeAudio(wavD.samples, wavD.sampleRate, `${specD.id}.wav`, undefined, {
    chordBand: null,
    bandStrategy: "unified", // 履歴再現のため明示固定（既定は split に変更済み）
  });
  const songD = {
    measurement: measureSong(truth, resultD),
    slash: measureSlash(truth, resultD),
  };

  // --- 回帰: Songs A–C ---
  const regSongs: SongMeasurement[] = [];
  let spuriousTotal = 0;
  for (const spec of SONGS) {
    const s = synthSong(spec, SAMPLE_RATE);
    const wavPath = join(TEST_AUDIO_DIR, `${spec.id}.wav`);
    writeWav16(wavPath, s.samples, SAMPLE_RATE);
    const wav = readWav16(wavPath);
    const res = await analyzeAudio(wav.samples, wav.sampleRate, `${spec.id}.wav`, undefined, {
      chordBand: null,
      bandStrategy: "unified", // 履歴再現のため明示固定（既定は split に変更済み）
    });
    regSongs.push(measureSong(s.truth, res));
    spuriousTotal += measureSlash(s.truth, res).spuriousSlashSec;
  }
  const totalDur = regSongs.reduce((sum, x) => sum + x.durationSec, 0);
  const regression = {
    songs: regSongs,
    rootAccuracy:
      regSongs.reduce((sum, x) => sum + x.rootAccuracy * x.durationSec, 0) / totalDur,
    triadAccuracy:
      regSongs.reduce((sum, x) => sum + x.triadAccuracy * x.durationSec, 0) / totalDur,
    spuriousSlashSec: spuriousTotal,
  };

  const result: Step2Result = { songD, regression };
  writeFileSync(join(MEASUREMENTS_DIR, "PHASE1_STEP2.md"), buildReport(result), "utf-8");
  writeFileSync(
    join(MEASUREMENTS_DIR, "phase1-step2-results.json"),
    JSON.stringify(result, null, 2) + "\n",
    "utf-8",
  );
  return result;
}

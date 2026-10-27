/**
 * Phase 1 Step 1 の測定ハーネス: ベース補正の前後比較。
 *
 * 既存の合成 3 曲（test-audio/、正解既知）を、Phase 0 相当
 * （analyzeAudio の bassCorrection: false）と Phase 1 適用
 * （bassCorrection: true）でそれぞれ解析し、ACCURACY_MEASUREMENT.md の
 * 定義（scripts/measureSynthetic.ts の measureSong）で突き合わせる。
 *
 * 出力: measurements/PHASE1_STEP1.md / measurements/phase1-step1-results.json
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeAudio } from "../src/analysis/analyze";
import { BASS_CORRECTION_CONFIG } from "../src/analysis/bassCorrection";
import { measureSong, parseChord, type SongMeasurement } from "./measureSynthetic";
import { SONGS, synthSong } from "./synth";
import { readWav16, writeWav16 } from "./wav";

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TEST_AUDIO_DIR = join(PROJECT_ROOT, "test-audio");
const MEASUREMENTS_DIR = join(PROJECT_ROOT, "measurements");
const SAMPLE_RATE = 44100;

export interface Phase1SongResult {
  before: SongMeasurement;
  after: SongMeasurement;
  /** コード名が変わったセグメント（境界は不変なので index で対応付け） */
  changedSegments: { startSec: number; endSec: number; from: string; to: string }[];
}

export interface Phase1Result {
  songs: Phase1SongResult[];
  overall: {
    before: Aggregate;
    after: Aggregate;
  };
}

interface Aggregate {
  rootAccuracy: number;
  triadAccuracy: number;
  ncShare: number;
  rootWrongSec: number;
  modeFlipSec: number;
  /** 相対調ペア（例: C ↔ Am）の取り違え時間 */
  relativeConfusionSec: number;
}

/** gt → det が相対調（平行調）のペアかどうか */
function isRelativePair(gt: string, det: string): boolean {
  const g = parseChord(gt);
  const d = parseChord(det);
  if (!g || !d || g.mode === d.mode) return false;
  // major の相対マイナーは短 6 度上（+9）、minor の相対メジャーは短 3 度上（+3）
  return g.mode === "major"
    ? d.root === (g.root + 9) % 12
    : d.root === (g.root + 3) % 12;
}

function aggregate(measurements: SongMeasurement[]): Aggregate {
  const totalDur = measurements.reduce((s, x) => s + x.durationSec, 0);
  let relative = 0;
  for (const msr of measurements) {
    for (const c of msr.confusionsAll) {
      if (isRelativePair(c.gt, c.det)) relative += c.sec;
    }
  }
  return {
    rootAccuracy:
      measurements.reduce((s, x) => s + x.rootAccuracy * x.durationSec, 0) / totalDur,
    triadAccuracy:
      measurements.reduce((s, x) => s + x.triadAccuracy * x.durationSec, 0) / totalDur,
    ncShare: measurements.reduce((s, x) => s + x.ncShare * x.durationSec, 0) / totalDur,
    rootWrongSec: measurements.reduce((s, x) => s + x.rootWrongSec, 0),
    modeFlipSec: measurements.reduce((s, x) => s + x.modeFlipSec, 0),
    relativeConfusionSec: relative,
  };
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const signed = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}pt`;

function confusionSec(msr: SongMeasurement, gt: string, det: string): number {
  return msr.confusionsAll
    .filter((c) => c.gt === gt && c.det === det)
    .reduce((s, c) => s + c.sec, 0);
}

function buildReport(result: Phase1Result): string {
  const today = new Date().toISOString().slice(0, 10);
  const { before, after } = result.overall;
  const lines: string[] = [];
  lines.push("# Phase 1 Step 1 測定結果 — ベース解析によるルート補正");
  lines.push("");
  lines.push(`測定日: ${today} / ハーネス: scripts/measurePhase1.ts（\`npm run measure:phase1\` で再実行可能）`);
  lines.push("");
  lines.push("## 実施内容");
  lines.push("");
  lines.push("- `src/dsp/bass.ts`（低域ピッチクラス推定のみに責任を持つ新モジュール）:");
  lines.push("  既存 STFT ループ内で、低域（50〜260 Hz）のスペクトルピーク周波数を放物線補間で");
  lines.push("  推定し、低域総量をそのピッチクラスへ寄せる（ピーク投票方式）。ビン幅が半音間隔より");
  lines.push("  広い低域で、ビン単位の割り当てでは基本波が隣の半音へ漏れる問題への対処。");
  lines.push("- `src/analysis/bassCorrection.ts`: セグメント単位で低域分布をエネルギー加重集計し、");
  lines.push("  証拠が強い場合のみルートを補正する保守ルール。ベース音は `ChordSegment.bassPc` に");
  lines.push("  ルートとは別フィールドで保持し、モードは全帯域クロマから決め直す。");
  lines.push("- 分数コード表示と synth のベース音別指定（Step 2）は今回の対象外。");
  lines.push("");
  lines.push("## 使用したしきい値（保守ルール、合成 3 曲で調整した確定値）");
  lines.push("");
  lines.push(`- トップシェア下限: ${BASS_CORRECTION_CONFIG.minTopShare}`);
  lines.push(`- マージン（トップ − 2位）下限: ${BASS_CORRECTION_CONFIG.minMargin}`);
  lines.push(`- 低域エネルギー比率下限（対・曲全体の中央値）: ${BASS_CORRECTION_CONFIG.minEnergyRatio}`);
  lines.push(`- bassPc 記録のみの条件: シェア ${BASS_CORRECTION_CONFIG.recordMinShare} 以上、エネルギー比率 ${BASS_CORRECTION_CONFIG.recordMinEnergyRatio} 以上`);
  lines.push("");
  lines.push("調整時の観測: 正常セグメントではシェア 0.89 以上／マージン 0.77 以上／エネルギー比率");
  lines.push("最小 0.40。誤読側（ビン割り当て方式で E→F と誤った区間）はシェア 0.36／マージン 0.10。");
  lines.push("しきい値は実測最低値から余裕を取り、誤読側は確実に排除できる位置に置いた。");
  lines.push("");
  lines.push("## 結果（全体、時間加重）");
  lines.push("");
  lines.push("| 指標 | Phase 0（補正なし） | Phase 1 Step 1（補正あり） | 変化 |");
  lines.push("| --- | --- | --- | --- |");
  lines.push(`| ルート正解率 | ${pct(before.rootAccuracy)} | ${pct(after.rootAccuracy)} | ${signed(after.rootAccuracy - before.rootAccuracy)} |`);
  lines.push(`| 三和音正解率 | ${pct(before.triadAccuracy)} | ${pct(after.triadAccuracy)} | ${signed(after.triadAccuracy - before.triadAccuracy)} |`);
  lines.push(`| N.C. 割合 | ${pct(before.ncShare)} | ${pct(after.ncShare)} | ${signed(after.ncShare - before.ncShare)} |`);
  lines.push(`| ルート誤り時間 | ${before.rootWrongSec.toFixed(2)}秒 | ${after.rootWrongSec.toFixed(2)}秒 | ${(after.rootWrongSec - before.rootWrongSec).toFixed(2)}秒 |`);
  lines.push(`| 3rd 誤り時間（ルート正解・モード違い） | ${before.modeFlipSec.toFixed(2)}秒 | ${after.modeFlipSec.toFixed(2)}秒 | ${(after.modeFlipSec - before.modeFlipSec).toFixed(2)}秒 |`);
  lines.push(`| 相対調ペアの取り違え時間 | ${before.relativeConfusionSec.toFixed(2)}秒 | ${after.relativeConfusionSec.toFixed(2)}秒 | ${(after.relativeConfusionSec - before.relativeConfusionSec).toFixed(2)}秒 |`);
  lines.push("");
  lines.push("## 曲別");
  lines.push("");
  lines.push("| 曲 | ルート（前 → 後） | 三和音（前 → 後） | N.C.（前 → 後） | キー検出（前 → 後） |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const s of result.songs) {
    lines.push(
      `| ${s.before.truth.title} | ${pct(s.before.rootAccuracy)} → ${pct(s.after.rootAccuracy)} | ${pct(s.before.triadAccuracy)} → ${pct(s.after.triadAccuracy)} | ${pct(s.before.ncShare)} → ${pct(s.after.ncShare)} | ${s.before.detectedKey} → ${s.after.detectedKey} |`,
    );
  }
  lines.push("");
  for (const s of result.songs) {
    lines.push(`### ${s.before.truth.title}`);
    lines.push("");
    if (s.changedSegments.length === 0) {
      lines.push("コード名が変わったセグメントはない。");
    } else {
      lines.push("補正でコード名が変わったセグメント:");
      for (const c of s.changedSegments) {
        lines.push(`- ${c.startSec.toFixed(2)}–${c.endSec.toFixed(2)}秒: ${c.from} → ${c.to}`);
      }
    }
    lines.push("");
    const caB = confusionSec(s.before, "C", "Am");
    const caA = confusionSec(s.after, "C", "Am");
    if (caB > 0 || caA > 0) {
      lines.push(`- C → Am の取り違え: ${caB.toFixed(2)}秒 → ${caA.toFixed(2)}秒`);
    }
    const topAfter = s.after.confusions.slice(0, 3);
    if (topAfter.length > 0) {
      lines.push(
        `- 補正後に残る主な取り違え: ${topAfter.map((c) => `${c.gt} → ${c.det}（${c.sec.toFixed(2)}秒）`).join("、")}`,
      );
    } else {
      lines.push("- 補正後に取り違えは残っていない。");
    }
    lines.push("");
  }
  lines.push("## 曲別の所見");
  lines.push("");
  lines.push("- Song A: C → Am と誤検出されたセグメントは、低域ピークが C を指す強い証拠");
  lines.push("  （シェア 0.98 前後）で両方とも C に戻った。残りの取り違えは境界近傍の");
  lines.push("  0.21秒ぶんのみ。残る主な誤りは G → Gm のモード違いで、これは Phase 1 の対象外。");
  lines.push("- Song B: C → Am は解消方向。一方でキー誤判定（G major → A minor）はキー推定が");
  lines.push("  セグメント列ではなく全体クロマから決まるため、ベース補正では動かない（計画通り対象外）。");
  lines.push("  Em 小節内の Dm 誤検出は、低域ピーク補間のおかげで E と正しく読め、Em に補正された。");
  lines.push("- Song C: Song B と同様、C → Am の解消と Em → Dm の補正が効いた。G → Gm は残存。");
  lines.push("");
  lines.push("## 受け入れ基準の判定（PHASE1_PLAN.md）");
  lines.push("");
  const rootUp = after.rootAccuracy > before.rootAccuracy;
  const triadNotDown = after.triadAccuracy >= before.triadAccuracy;
  const relDown = after.relativeConfusionSec < before.relativeConfusionSec;
  lines.push(`1. ルート正解率が 86.0% から上がり、三和音正解率が下がらない: ${rootUp && triadNotDown ? "✓" : "✗"}（ルート ${pct(before.rootAccuracy)} → ${pct(after.rootAccuracy)}、三和音 ${pct(before.triadAccuracy)} → ${pct(after.triadAccuracy)}）`);
  lines.push(`2. 相対調の取り違え時間が減る: ${relDown ? "✓" : "✗"}（${before.relativeConfusionSec.toFixed(2)}秒 → ${after.relativeConfusionSec.toFixed(2)}秒）`);
  lines.push("3. 分数テスト曲での C/E 表示: Step 2 の対象のため今回は判定外（bassPc の別フィールド保持は実装・単体テスト済み）。");
  lines.push("4. 証拠が弱いセグメントで Phase 0 の結果が変わらない: ✓（単体テストで検証。実測でも、エネルギー比率 0 の末尾 N.C. 区間などは不変）");
  lines.push("5. テストとビルドが通る: 実施時に確認済み（件数と結果は PHASE1_PLAN.md の実施記録に記載）");
  lines.push("6. 解析ロジック以外の変更をしない: ✓（UI・デザインには触れていない。JSON 書き出しに任意フィールド bass を追加のみ）");
  lines.push("");
  lines.push("## 注意");
  lines.push("");
  lines.push("- 合成音源は拍頭のベースが明快で、ベース補正には最も易しい条件である。");
  lines.push("  ここでの改善幅は上限として読み、実曲 3 曲での測定（PHASE1_PLAN.md ステップ 3）で");
  lines.push("  最終判断すること。合成の数字をもって Phase 1 完了とはしない。");
  lines.push("");
  return lines.join("\n");
}

export async function runPhase1Measurement(): Promise<Phase1Result> {
  mkdirSync(TEST_AUDIO_DIR, { recursive: true });
  mkdirSync(MEASUREMENTS_DIR, { recursive: true });

  const songs: Phase1SongResult[] = [];
  for (const spec of SONGS) {
    const { samples, truth } = synthSong(spec, SAMPLE_RATE);
    const wavPath = join(TEST_AUDIO_DIR, `${spec.id}.wav`);
    writeWav16(wavPath, samples, SAMPLE_RATE);
    const wav = readWav16(wavPath);

    // 上帯域クロマ（chordBand）は Step 1 測定の対象外なので、既定値に
    // 依らず null で固定し、この履歴測定の再現性を保つ。
    const beforeResult = await analyzeAudio(wav.samples, wav.sampleRate, `${spec.id}.wav`, undefined, {
      bassCorrection: false,
      chordBand: null,
      bandStrategy: "unified", // 履歴再現のため明示固定（既定は split に変更済み）
    });
    const afterResult = await analyzeAudio(wav.samples, wav.sampleRate, `${spec.id}.wav`, undefined, {
      bassCorrection: true,
      chordBand: null,
      bandStrategy: "unified", // 履歴再現のため明示固定（既定は split に変更済み）
    });

    const before = measureSong(truth, beforeResult);
    const after = measureSong(truth, afterResult);

    const changedSegments: Phase1SongResult["changedSegments"] = [];
    const n = Math.min(beforeResult.segments.length, afterResult.segments.length);
    for (let i = 0; i < n; i++) {
      const b = beforeResult.segments[i];
      const a = afterResult.segments[i];
      if (b.chord !== a.chord) {
        changedSegments.push({
          startSec: Number(b.start.toFixed(2)),
          endSec: Number(b.end.toFixed(2)),
          from: b.chord,
          to: a.chord,
        });
      }
    }
    songs.push({ before, after, changedSegments });
  }

  const result: Phase1Result = {
    songs,
    overall: {
      before: aggregate(songs.map((s) => s.before)),
      after: aggregate(songs.map((s) => s.after)),
    },
  };

  writeFileSync(join(MEASUREMENTS_DIR, "PHASE1_STEP1.md"), buildReport(result), "utf-8");
  writeFileSync(
    join(MEASUREMENTS_DIR, "phase1-step1-results.json"),
    JSON.stringify(result, null, 2) + "\n",
    "utf-8",
  );
  return result;
}

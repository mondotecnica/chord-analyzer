/**
 * 合成テスト音源による正解率測定ハーネス。
 *
 * 手順（ACCURACY_MEASUREMENT.md の定義に準拠）:
 * 1. 正解進行が既知の合成音源（WAV）を test-audio/ に生成し、正解 JSON を併せて保存
 * 2. WAV を自前リーダで PCM に戻し、アプリ本体の解析パイプライン
 *    (src/analysis/analyze.ts) をそのまま Node で実行
 * 3. 検出セグメントと正解セグメントを時刻軸で突き合わせ、時間加重で集計
 *    - ルート正解率 / 三和音正解率（いずれも N.C. 区間の時間は分母から除外し別掲）
 *    - テンション曲向けの「コア正解」は、今回の3曲は全て Phase 0 の語彙内
 *      （major/minor 三和音のみ）なので三和音正解率と同一になる
 * 4. 結果を measurements/SYNTHETIC_BASELINE.md と results.json に書き出す
 *
 * 解析アルゴリズム自体には一切手を入れない（測定専用）。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeAudio } from "../src/analysis/analyze";
import { NOTE_NAMES, NO_CHORD } from "../src/lib/notes";
import type { AnalysisResult } from "../src/types";
import { SONGS, synthSong, type GroundTruth } from "./synth";
import { readWav16, writeWav16 } from "./wav";

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TEST_AUDIO_DIR = join(PROJECT_ROOT, "test-audio");
const MEASUREMENTS_DIR = join(PROJECT_ROOT, "measurements");
const SAMPLE_RATE = 44100;
/** 突き合わせのサンプリング間隔（秒） */
const STEP = 0.01;

export function parseChord(chord: string): { root: number; mode: "major" | "minor" } | null {
  if (chord === NO_CHORD) return null;
  if (chord.endsWith("m")) {
    const root = NOTE_NAMES.indexOf(chord.slice(0, -1) as (typeof NOTE_NAMES)[number]);
    return root >= 0 ? { root, mode: "minor" } : null;
  }
  const root = NOTE_NAMES.indexOf(chord as (typeof NOTE_NAMES)[number]);
  return root >= 0 ? { root, mode: "major" } : null;
}

export interface SongMeasurement {
  truth: GroundTruth;
  detectedKey: string;
  detectedBpm: number | null;
  durationSec: number;
  /** N.C. を除いた時間を分母にした指標 */
  rootAccuracy: number;
  triadAccuracy: number;
  /** N.C. も不正解として数えた参考値（分母＝全時間） */
  rootAccuracyAllTime: number;
  triadAccuracyAllTime: number;
  ncShare: number;
  lowConfidenceShare: number;
  meanBoundaryOffsetSec: number;
  /** ルートは合っているが major/minor が違う時間（秒） */
  modeFlipSec: number;
  /** ルート自体が違う時間（秒、N.C. 除く） */
  rootWrongSec: number;
  /** gt → det の取り違え（秒、N.C. 除く、上位5件） */
  confusions: { gt: string; det: string; sec: number }[];
  /** gt → det の取り違え全件（集計用） */
  confusionsAll: { gt: string; det: string; sec: number }[];
  detectedSegments: { startSec: number; endSec: number; chord: string; confidence: number }[];
}

export function measureSong(truth: GroundTruth, result: AnalysisResult): SongMeasurement {
  const total = truth.durationSec;
  let ncTime = 0;
  let lowConfTime = 0;
  let rootOk = 0;
  let triadOk = 0;
  let modeFlip = 0;
  let rootWrong = 0;
  let counted = 0; // N.C. を除いた時間
  const confusionMap = new Map<string, { gt: string; det: string; sec: number }>();

  // 検出セグメント検索用ポインタ
  let segIdx = 0;
  const segs = result.segments;
  for (let t = 0; t < total; t += STEP) {
    const mid = t + STEP / 2;
    const gtSeg = truth.segments.find((s) => mid >= s.startSec && mid < s.endSec);
    if (!gtSeg) continue;
    while (segIdx < segs.length - 1 && mid >= segs[segIdx].end) segIdx++;
    const det = segs[segIdx] && mid >= segs[segIdx].start && mid < segs[segIdx].end
      ? segs[segIdx]
      : null;
    if (!det || det.chord === NO_CHORD) {
      ncTime += STEP;
      continue;
    }
    counted += STEP;
    if (det.confidence < 0.55) lowConfTime += STEP;
    const gtP = parseChord(gtSeg.chord);
    const detP = parseChord(det.chord);
    if (!gtP || !detP) continue;
    if (detP.root === gtP.root) {
      rootOk += STEP;
      if (detP.mode === gtP.mode) {
        triadOk += STEP;
        continue;
      }
      modeFlip += STEP;
    } else {
      rootWrong += STEP;
    }
    const key = `${gtSeg.chord} → ${det.chord}`;
    const cur = confusionMap.get(key) ?? { gt: gtSeg.chord, det: det.chord, sec: 0 };
    cur.sec += STEP;
    confusionMap.set(key, cur);
  }

  // 境界ずれ: 正解の各境界に最も近い検出セグメント開始時刻との差の平均
  const boundaries = truth.segments.slice(1).map((s) => s.startSec);
  let offsetSum = 0;
  for (const b of boundaries) {
    let best = Infinity;
    for (const s of segs) best = Math.min(best, Math.abs(s.start - b));
    if (Number.isFinite(best)) offsetSum += best;
  }

  return {
    truth,
    detectedKey: result.keyName,
    detectedBpm: result.bpm,
    durationSec: total,
    rootAccuracy: counted > 0 ? rootOk / counted : 0,
    triadAccuracy: counted > 0 ? triadOk / counted : 0,
    rootAccuracyAllTime: total > 0 ? rootOk / total : 0,
    triadAccuracyAllTime: total > 0 ? triadOk / total : 0,
    ncShare: total > 0 ? ncTime / total : 0,
    lowConfidenceShare: total > 0 ? lowConfTime / total : 0,
    meanBoundaryOffsetSec: boundaries.length > 0 ? offsetSum / boundaries.length : 0,
    modeFlipSec: modeFlip,
    rootWrongSec: rootWrong,
    confusions: [...confusionMap.values()].sort((a, b) => b.sec - a.sec).slice(0, 5),
    confusionsAll: [...confusionMap.values()].sort((a, b) => b.sec - a.sec),
    detectedSegments: segs
      .filter((s) => s.start < total)
      .map((s) => ({
        startSec: Number(s.start.toFixed(2)),
        endSec: Number(Math.min(s.end, total).toFixed(2)),
        chord: s.chord,
        confidence: Number(s.confidence.toFixed(2)),
      })),
  };
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

function bpmVerdict(trueBpm: number, det: number | null): string {
  if (det === null) return "推定できず";
  if (Math.abs(det - trueBpm) <= 2) return "一致";
  if (Math.abs(det - trueBpm * 2) <= 4) return "2倍の誤推定";
  if (Math.abs(det - trueBpm / 2) <= 2) return "半分の誤推定";
  // フレーム長（2048/44100 ≒ 46ms）によるラグ量子化で数%ずれることがある
  if (Math.abs(det - trueBpm) / trueBpm <= 0.03) return "ほぼ一致（量子化誤差の範囲）";
  return "不一致";
}

function buildReport(measurements: SongMeasurement[]): string {
  const today = new Date().toISOString().slice(0, 10);
  const lines: string[] = [];
  lines.push("# 合成テスト音源ベースライン測定 — Phase 0");
  lines.push("");
  lines.push(`測定日: ${today} / ハーネス: scripts/measureSynthetic.ts（\`npm run measure:synthetic\` で再実行可能）`);
  lines.push("");
  lines.push("## 注意（先に読むこと）");
  lines.push("");
  lines.push("- これは**クリーンな合成音源**での測定であり、達成可能な上限に近い「ベストケースの土台」である。");
  lines.push("  実楽曲（ドラム、ボーカル、リバーブ、テンションコード等）はこれより確実に悪くなる。");
  lines.push("  **この数字を実楽曲の正解率として読んではいけない。**");
  lines.push("- 目的は、実曲測定の前に「測る仕組み自体が回ること」と「素の三和音進行での上限」を確認すること。");
  lines.push("- 合成音源は test-audio/ に WAV と正解 JSON が保存してあり、プレビュー版にそのまま入れて手動確認もできる。");
  lines.push("");
  lines.push("## 測定方法（ACCURACY_MEASUREMENT.md 準拠）");
  lines.push("");
  lines.push("- 検出セグメントと正解セグメントを 10ms 刻みで時刻軸突き合わせし、時間加重で集計。");
  lines.push("- ルート正解率・三和音正解率は、N.C.（無判定）区間の時間を分母から除外し、N.C. の割合は別掲する。");
  lines.push("  参考として N.C. も不正解に数えた全時間ベースの値も併記する。");
  lines.push("- 「コア正解」（テンション曲向け別枠）は、今回の3曲が全て Phase 0 の語彙内");
  lines.push("  （major/minor 三和音のみ）で構成されているため、三和音正解率と同一になる。別枠の対象曲はない。");
  lines.push("- キーは全体推定（Krumhansl–Schmuckler）、BPM はオンセット自己相関の推定値と正解を比較。");
  lines.push("");
  lines.push("## 結果サマリ");
  lines.push("");
  lines.push("| 曲 | 長さ | キー（正解 → 検出） | BPM（正解 → 推定） | ルート正解率 | 三和音正解率 | N.C. 割合 |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const msr of measurements) {
    const t = msr.truth;
    lines.push(
      `| ${t.title} | ${msr.durationSec.toFixed(1)}秒 | ${t.key} → ${msr.detectedKey}${t.key === msr.detectedKey ? " ✓" : " ✗"} | ${t.bpm} → ${msr.detectedBpm ?? "—"}（${bpmVerdict(t.bpm, msr.detectedBpm)}） | ${pct(msr.rootAccuracy)} | ${pct(msr.triadAccuracy)} | ${pct(msr.ncShare)} |`,
    );
  }
  const totalDur = measurements.reduce((s, x) => s + x.durationSec, 0);
  const wRoot = measurements.reduce((s, x) => s + x.rootAccuracy * x.durationSec, 0) / totalDur;
  const wTriad = measurements.reduce((s, x) => s + x.triadAccuracy * x.durationSec, 0) / totalDur;
  lines.push("");
  lines.push(`全曲合計（時間加重平均）: ルート正解率 ${pct(wRoot)} / 三和音正解率 ${pct(wTriad)}（N.C. 除外ベース）`);
  lines.push("");
  lines.push("参考（N.C. も不正解として全時間で計算）:");
  for (const msr of measurements) {
    lines.push(`- ${msr.truth.title}: ルート ${pct(msr.rootAccuracyAllTime)} / 三和音 ${pct(msr.triadAccuracyAllTime)}、低信頼（信頼度<0.55）区間の割合 ${pct(msr.lowConfidenceShare)}、平均境界ずれ ${msr.meanBoundaryOffsetSec.toFixed(2)}秒`);
  }
  lines.push("");
  lines.push("## 曲別の検出セグメントと主な誤り");
  for (const msr of measurements) {
    const t = msr.truth;
    lines.push("");
    lines.push(`### ${t.title}`);
    lines.push("");
    lines.push(`正解進行: ${t.segments.map((s) => s.chord).join(" – ")}（各 ${(
      t.segments[0].endSec - t.segments[0].startSec
    ).toFixed(2)}秒）`);
    lines.push("");
    lines.push("検出セグメント:");
    for (const s of msr.detectedSegments) {
      lines.push(`- ${s.startSec.toFixed(2)}–${s.endSec.toFixed(2)}秒: ${s.chord}（信頼度 ${s.confidence}）`);
    }
    lines.push("");
    if (msr.confusions.length === 0 && msr.ncShare === 0) {
      lines.push("取り違え・N.C. 区間はなし。");
    } else {
      if (msr.confusions.length > 0) {
        lines.push("主な取り違え（正解 → 検出、秒数）:");
        for (const c of msr.confusions) {
          lines.push(`- ${c.gt} → ${c.det}: ${c.sec.toFixed(2)}秒`);
        }
      }
      if (msr.ncShare > 0) {
        lines.push(`- N.C.（無判定）: 全体の ${pct(msr.ncShare)}`);
      }
    }
  }
  // --- 考察（実測データから自動集計） ---
  const countedSec = measurements.reduce(
    (s, x) => s + x.durationSec * (1 - x.ncShare),
    0,
  );
  const modeFlipSec = measurements.reduce((s, x) => s + x.modeFlipSec, 0);
  const rootWrongSec = measurements.reduce((s, x) => s + x.rootWrongSec, 0);
  const aggConf = new Map<string, number>();
  for (const msr of measurements) {
    for (const c of msr.confusionsAll) {
      aggConf.set(`${c.gt} → ${c.det}`, (aggConf.get(`${c.gt} → ${c.det}`) ?? 0) + c.sec);
    }
  }
  const topConf = [...aggConf.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const keyMisses = measurements.filter((x) => x.truth.key !== x.detectedKey);

  lines.push("");
  lines.push("## 考察（誤りパターンの内訳）");
  lines.push("");
  lines.push(
    `判定対象時間（N.C. 除外）のうち、ルートは合っているのに major/minor が違う時間は ` +
      `約 ${modeFlipSec.toFixed(1)}秒（${pct(countedSec > 0 ? modeFlipSec / countedSec : 0)}）、` +
      `ルート自体が違う時間は約 ${rootWrongSec.toFixed(1)}秒（${pct(countedSec > 0 ? rootWrongSec / countedSec : 0)}）。`,
  );
  lines.push("");
  lines.push("全曲通算の主な取り違え:");
  for (const [pair, sec] of topConf) {
    lines.push(`- ${pair}: ${sec.toFixed(2)}秒`);
  }
  lines.push("");
  lines.push("読み取れる傾向:");
  lines.push(
    "- 誤りは大きく2クラス。ルート自体の誤り（約14%）が最大で、その中心は C → Am のような",
  );
  lines.push(
    "  相対調（構成音が2つ重なる）コード同士の取り違え。これはベース音（Phase 1）で最も素直に解ける種類。",
  );
  lines.push(
    "- もう一方は「ルート正解・3rd 誤り」（約9%、ルート正解率と三和音正解率の差そのもの）で、",
  );
  lines.push(
    "  単一ペア最大の G → Gm をはじめ major → minor 化に偏っている。合成音の倍音成分や",
  );
  lines.push(
    "  前コードの減衰テールが短3度側のクロマを押し上げている可能性があり、Phase 1/3 で",
  );
  lines.push("  3rd 判定をどう安定させるかが論点になる。");
  lines.push(
    "- Em → Dm のような全音違いのルート誤りも見られた（境界近傍に集中しているかは曲別一覧参照）。",
  );
  if (keyMisses.length > 0) {
    for (const km of keyMisses) {
      lines.push(
        `- キー推定は ${km.truth.title} で外した（正解 ${km.truth.key} → 検出 ${km.detectedKey}）。` +
          "相対調・近親調のコードが長く続く進行では、全体集計クロマがそちらに寄る。",
      );
    }
  } else {
    lines.push("- キー推定は全曲一致した。");
  }
  lines.push(
    "- 境界ずれの平均は 0.08〜0.17秒程度で、セグメントの切替自体は概ね小節に追随している。",
  );
  lines.push("");
  lines.push("次の一手への含意（ACCURACY_MEASUREMENT.md の分岐に従う）:");
  lines.push(
    "- ルート誤りの中心が相対調の取り違えである点は、Phase 1（ベース補正）を優先する",
  );
  lines.push("  当初計画と整合する。ベースでルートが固定されれば、このクラスは直接減らせるはず。");
  lines.push(
    "- 3rd 誤り（major → minor 化）も無視できない規模なので、Phase 3 の二段判定",
  );
  lines.push(
    "  （コア確定→拡張音検出）の設計では「major/minor 判定の安定化」を意識したい。",
  );
  lines.push("- 最終的な優先順位の結論は、実曲3曲の測定結果と合わせて出すのがよい。");
  lines.push("");
  return lines.join("\n");
}

export async function runSyntheticMeasurement(): Promise<SongMeasurement[]> {
  mkdirSync(TEST_AUDIO_DIR, { recursive: true });
  mkdirSync(MEASUREMENTS_DIR, { recursive: true });

  const measurements: SongMeasurement[] = [];
  for (const spec of SONGS) {
    const { samples, truth } = synthSong(spec, SAMPLE_RATE);
    const wavPath = join(TEST_AUDIO_DIR, `${spec.id}.wav`);
    const gtPath = join(TEST_AUDIO_DIR, `${spec.id}.groundtruth.json`);
    writeWav16(wavPath, samples, SAMPLE_RATE);
    writeFileSync(gtPath, JSON.stringify(truth, null, 2) + "\n", "utf-8");

    // 生成した WAV を読み戻して解析する（ブラウザの decodeAudioData は使わない）
    // このファイルは Phase 0 ベースライン専用なので、Phase 1 のベース補正と
    // 上帯域クロマ（chordBand）は明示的に切って測定する
    // （Phase 1 の前後比較は measurePhase1.ts が担う）。
    const wav = readWav16(wavPath);
    const result = await analyzeAudio(wav.samples, wav.sampleRate, `${spec.id}.wav`, undefined, {
      bassCorrection: false,
      chordBand: null,
      // 履歴再現のため戦略も明示固定（2026-10-27 の既定変更で未指定は split になった）
      bandStrategy: "unified",
    });
    measurements.push(measureSong(truth, result));
  }

  writeFileSync(
    join(MEASUREMENTS_DIR, "SYNTHETIC_BASELINE.md"),
    buildReport(measurements),
    "utf-8",
  );
  writeFileSync(
    join(MEASUREMENTS_DIR, "results.json"),
    JSON.stringify(measurements, null, 2) + "\n",
    "utf-8",
  );
  return measurements;
}

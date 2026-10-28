/**
 * Phase 3.1 の拡張音（7th）採点 — 既存指標（ルート／三和音／コア）とは
 * 別の物差し。既存ハーネス（measureSynthetic / measureReal）の数値定義には
 * 一切触れず、比較可能性を保つ。
 *
 * 指標（すべて時間加重、サンプリング間隔は既存ハーネスと同じ 10ms）:
 * - 完全ラベル正解率: 正解の拡張クラスが {maj7, 7, m7, なし} の時間に
 *   ついて、検出の（ルート＋モード＋拡張）が完全一致した割合。
 *   分母は既存指標と同じく「検出が N.C. でない時間」。
 * - コア正解時の 7th 正解率: 正解が語彙内 7th（maj7/7/m7）で、かつ
 *   検出のコア（ルート＋モード）が合っている時間について、
 *   拡張まで一致した割合。第2段だけの純粋な実力を測る。
 * - 7th 完全一致率（正解 7th 基準）: 正解が語彙内 7th の時間について
 *   ルート＋モード＋拡張が全部一致した割合（検出 N.C. は分母から除外）。
 * - 誤発火率: 正解が純粋な三和音（拡張なし）の時間について、
 *   検出が拡張を付けてしまった割合。
 * 正解の拡張クラスが "other"（9th、add9、sus、m7♭5、6 等、初期語彙外）
 * の時間は、完全ラベル系の分母から除外する（構造的に一致できないため。
 * コア正解率は既存ハーネス側で別途測る）。
 */
import { NO_CHORD } from "../src/lib/notes";
import { fullChordName } from "../src/lib/chordDisplay";
import type { AnalysisResult } from "../src/types";
import type { ChordExtension } from "../src/types";
import { parseTruthChord } from "./measureReal";
import { parseChord } from "./measureSynthetic";
import type { GroundTruthSegment } from "./synth";

const STEP = 0.01;

export type ExtensionClass = ChordExtension | "other" | null;

export interface TruthLabel {
  root: number;
  /** 三和音コアのモード。sus 等で定まらない場合は null（その時間は対象外） */
  coreMode: "major" | "minor" | null;
  ext: ExtensionClass;
}

/**
 * 完全なコード名（例: "Dmaj7", "B7", "F#m7", "D7sus4", "Fadd9"）の
 * クオリティ部分を拡張クラスに分類する。初期語彙（maj7/7/m7）に
 * 入らない拡張はすべて "other"。
 */
export function extensionClassOf(quality: string): ExtensionClass {
  const q = quality;
  if (q === "" || q === "m" || q === "min") return null;
  // sus / add / 複合テンション / ♭5 系 / 6 / 9 / 11 / 13 は初期語彙外。
  // "maj7" "m7" の判定より先に弾く（"m7♭5" を m7 と誤認しないため）
  if (/sus|add|\(|♭|b5|dim|aug|6|9|11|13/.test(q)) return "other";
  if (/maj7|M7|Δ/.test(q)) return "maj7";
  if (/^m/.test(q) && /7/.test(q)) return "m7";
  if (/7/.test(q)) return "7";
  return "other";
}

/** 完全ラベル（実曲の正解表記）→ TruthLabel */
export function truthLabelFromFullName(chord: string): TruthLabel | null {
  const core = parseTruthChord(chord);
  if (!core) return null;
  const main = chord.split("/")[0].replace("♭", "b").replace("♯", "#");
  const m = main.match(/^([A-G])(#|b)?(.*)$/);
  const quality = m?.[3] ?? "";
  return { root: core.root, coreMode: core.coreMode, ext: extensionClassOf(quality) };
}

/** 合成曲の正解セグメント（chord=コア、fullChord=完全名）→ TruthLabel */
export function truthLabelFromSynthetic(seg: GroundTruthSegment): TruthLabel | null {
  const core = parseChord(seg.chord);
  if (!core) return null;
  if (!seg.fullChord) return { root: core.root, coreMode: core.mode, ext: null };
  const q = seg.fullChord.replace(/^[A-G]#?/, "");
  return { root: core.root, coreMode: core.mode, ext: extensionClassOf(q) };
}

export interface ExtensionTruthSegment {
  startSec: number;
  endSec: number;
  label: string;
  truth: TruthLabel;
}

export interface ExtensionMeasurement {
  /** 完全ラベル正解率（正解 ext ∈ {maj7,7,m7,なし}、検出 N.C. 除外） */
  fullLabelAccuracy: number | null;
  fullLabelCountedSec: number;
  /** コア正解時の 7th 正解率（正解 ext ∈ {maj7,7,m7} かつコア一致の時間内） */
  seventhGivenCore: number | null;
  seventhGivenCoreSec: number;
  /** 正解 7th に対する完全一致率（ルート＋モード＋拡張、検出 N.C. 除外） */
  seventhExactAccuracy: number | null;
  seventhTruthSec: number;
  /** 誤発火率（正解 ext なしの時間で検出が拡張を付けた割合） */
  falseFireRate: number | null;
  falseFireSec: number;
  ncShare: number;
  confusions: { gt: string; det: string; sec: number }[];
}

const IN_VOCAB: ReadonlySet<ExtensionClass> = new Set(["maj7", "7", "m7"]);

export function measureExtensions(
  truthSegments: ExtensionTruthSegment[],
  durationSec: number,
  result: AnalysisResult,
): ExtensionMeasurement {
  let ncTime = 0;
  let fullCounted = 0;
  let fullOk = 0;
  let givenCoreCounted = 0;
  let givenCoreOk = 0;
  let seventhCounted = 0;
  let seventhOk = 0;
  let triadCounted = 0;
  let falseFire = 0;
  const confusionMap = new Map<string, { gt: string; det: string; sec: number }>();

  let segIdx = 0;
  const segs = result.segments;
  for (let t = 0; t < durationSec; t += STEP) {
    const mid = t + STEP / 2;
    const gtSeg = truthSegments.find((s) => mid >= s.startSec && mid < s.endSec);
    if (!gtSeg) continue;
    while (segIdx < segs.length - 1 && mid >= segs[segIdx].end) segIdx++;
    const det =
      segs[segIdx] && mid >= segs[segIdx].start && mid < segs[segIdx].end
        ? segs[segIdx]
        : null;
    if (!det || det.chord === NO_CHORD) {
      ncTime += STEP;
      continue;
    }
    const gt = gtSeg.truth;
    if (gt.coreMode === null) continue;
    const detP = parseChord(det.chord);
    if (!detP) continue;
    const detExt: ExtensionClass = det.extension ?? null;
    const coreOk = detP.root === gt.root && detP.mode === gt.coreMode;
    const exact = coreOk && detExt === gt.ext;

    if (gt.ext === null || IN_VOCAB.has(gt.ext)) {
      fullCounted += STEP;
      if (exact) fullOk += STEP;
    }
    if (gt.ext !== null && IN_VOCAB.has(gt.ext)) {
      seventhCounted += STEP;
      if (exact) seventhOk += STEP;
      if (coreOk) {
        givenCoreCounted += STEP;
        if (detExt === gt.ext) givenCoreOk += STEP;
      }
    }
    if (gt.ext === null) {
      triadCounted += STEP;
      if (detExt !== null) falseFire += STEP;
    }
    if (!exact && (gt.ext === null || IN_VOCAB.has(gt.ext))) {
      const detLabel = fullChordName(det.chord, det.extension);
      const key = `${gtSeg.label} → ${detLabel}`;
      const cur = confusionMap.get(key) ?? { gt: gtSeg.label, det: detLabel, sec: 0 };
      cur.sec += STEP;
      confusionMap.set(key, cur);
    }
  }
  return {
    fullLabelAccuracy: fullCounted > 0 ? fullOk / fullCounted : null,
    fullLabelCountedSec: fullCounted,
    seventhGivenCore: givenCoreCounted > 0 ? givenCoreOk / givenCoreCounted : null,
    seventhGivenCoreSec: givenCoreCounted,
    seventhExactAccuracy: seventhCounted > 0 ? seventhOk / seventhCounted : null,
    seventhTruthSec: seventhCounted,
    falseFireRate: triadCounted > 0 ? falseFire / triadCounted : null,
    falseFireSec: triadCounted,
    ncShare: durationSec > 0 ? ncTime / durationSec : 0,
    confusions: [...confusionMap.values()].sort((a, b) => b.sec - a.sec).slice(0, 8),
  };
}

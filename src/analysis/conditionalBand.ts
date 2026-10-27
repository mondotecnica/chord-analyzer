import { medianLowBandFrameTotal } from "../dsp/bass";
import { isChordToneBass } from "../lib/chordDisplay";
import { chordName } from "../lib/notes";
import type { ChordSegment } from "../types";
import {
  assessSegmentBass,
  chordChromaScore,
  parseChordName,
} from "./bassCorrection";
import { CHORD_TEMPLATES } from "./chordEstimation";

/**
 * Phase 1.5b: 条件分岐（崩壊シグネチャのあるセグメントでのみ、
 * ルート判定にも上帯域を参照する）。
 *
 * 背景（measurements/PHASE1_5_HYBRID.md）: 実曲の病気（モード反転）は
 * 分業（split）が治し、分数コードの病気（Song D: ベースが構成音を
 * 強く鳴らすと全帯域クロマが引っ張られ、フレーム判定の時点でルートが
 * 崩れる。G/B → Bm、Am/E → Em）は unified-260 しか治せなかった。
 * 分業はルート経路を全帯域に固定するため Song D には原理的に届かない。
 * 本モジュールは split の後段に条件分岐を足し、2 つの病気を
 * セグメント単位で切り分ける:
 *
 * - 崩壊シグネチャが無いセグメント: split の結果をそのまま使う
 *   （ルートは全帯域＋ベース補正のまま）。
 * - シグネチャがあるセグメントだけ: ルート（とモード）を上帯域
 *   クロマの最良候補で決め直す。ベース音は新ルートの構成音に
 *   なっているため、表示側では G/B のような分数表示になる。
 *
 * 崩壊シグネチャの定義（全条件を満たす場合に発火する）:
 * 1. 低域の証拠が強い（assessSegmentBass の strong。BASS_CORRECTION_CONFIG
 *    のシェア 0.5／マージン 0.2／エネルギー比率 0.3 をそのまま流用）。
 * 2. ベース音（低域トップ）が検出コードのルートと一致する。
 *    ＝ベースの基本波がフレーム判定を支配して「ベース音そのものが
 *    ルートとして検出された」形になっている。
 * 3. 上帯域クロマの最良候補のルートが、検出ルートと異なる。
 * 4. ベース音が上帯域候補コードの構成音（3rd / 5th）である。
 *    ＝候補コード＋そのベース音が分数コードとして整合する
 *    （例: 候補 G、ベース B → G/B）。これが無い候補は相対調などの
 *    別コードへの流れであり、崩壊とはみなさない。
 * 5. 上帯域での候補スコア − 検出コードのスコア が
 *    COLLAPSE_SIGNATURE_CONFIG.minUpperBandGap 以上。
 *
 * 分離の実測根拠（合成 4 曲、2026-10-27。PHASE1_5B_CONDITIONAL.md）:
 * - Song D の崩壊セグメント 8 件は全条件を満たし、条件 5 のスコア差は
 *   0.168〜0.508 だった。
 * - Songs A–C で条件 2・3 を満たすセグメントは 2 件のみで、いずれも
 *   条件 4 を満たさず、スコア差も 0.000／0.020 に留まった。
 * - Song D の健全な分数セグメント（C/E 等、ルート正解）は条件 2 を
 *   満たさない（ベース音≠検出ルート）ため発火しない。
 * しきい値 0.10 はこの分離区間（ノイズ側 ≤0.020／信号側 ≥0.168）の
 * 中ほどに置いた。実曲はしきい値調整には使っていない（検証専用）。
 *
 * 割り切り（split と共通）:
 * - 補正はセグメント単位のみ。境界・信頼度・bassPc は変えない
 *   （信頼度は全帯域フレーム判定由来のまま再計算しない）。
 * - N.C. セグメントは対象外。
 * - 発火時は候補のモードもそのまま採用する。後段の applyUpperBandMode
 *   （split のモード決め直し）が新ルートについて上帯域でモードを
 *   再評価するが、候補は上帯域の全テンプレート中の最良なので、
 *   結果は候補のモードと一致する。
 */

/** 条件分岐のしきい値（確定値。根拠は上記コメントと PHASE1_PLAN.md） */
export const COLLAPSE_SIGNATURE_CONFIG = {
  /**
   * 発火に必要な、上帯域クロマでの候補スコア − 検出コードスコアの下限。
   * 合成での実測: 崩壊セグメント 0.168 以上、非崩壊の候補相違は 0.020 以下。
   */
  minUpperBandGap: 0.1,
} as const;

export interface BandCandidate {
  root: number;
  mode: "major" | "minor";
  /** その帯域のセグメント平均クロマとの一致度（コサイン類似度） */
  score: number;
}

/**
 * 帯域クロマのセグメント平均に対して最も合うコード（全 24 テンプレート）を返す。
 * 証拠が無い（最良スコアが 0 以下）場合は null。
 */
export function bestChordFromBand(
  chromaFrames: Float32Array[],
  energies: Float32Array,
  startIdx: number,
  endIdx: number,
): BandCandidate | null {
  let best: BandCandidate | null = null;
  for (const t of CHORD_TEMPLATES) {
    const score = chordChromaScore(chromaFrames, energies, startIdx, endIdx, t.root, t.mode);
    if (!best || score > best.score) best = { root: t.root, mode: t.mode, score };
  }
  if (!best || best.score <= 0) return null;
  return best;
}

export interface CollapseAssessment {
  /** 崩壊シグネチャが揃い、上帯域ルートへ決め直すべきか */
  fires: boolean;
  /** 上帯域の最良候補（証拠が無い場合は null） */
  candidate: BandCandidate | null;
  /** 候補スコア − 検出コードの上帯域スコア（候補が無い場合は 0） */
  upperBandGap: number;
  /** 低域の証拠が強いか（assessSegmentBass の strong） */
  bassStrong: boolean;
  /** 低域トップのピッチクラス */
  bassTopPc: number;
}

/** 純粋述語: 観測値の組から発火するかどうかだけを判定する（単体テスト用） */
export function collapseSignatureFires(ev: {
  bassStrong: boolean;
  bassTopPc: number;
  detectedRoot: number;
  candidate: BandCandidate | null;
  upperBandGap: number;
}): boolean {
  if (!ev.bassStrong) return false;
  if (ev.bassTopPc !== ev.detectedRoot) return false;
  const cand = ev.candidate;
  if (!cand) return false;
  if (cand.root === ev.detectedRoot) return false;
  if (!isChordToneBass(cand.root, cand.mode, ev.bassTopPc)) return false;
  if (ev.upperBandGap < COLLAPSE_SIGNATURE_CONFIG.minUpperBandGap) return false;
  return true;
}

/**
 * 1 セグメントについて崩壊シグネチャを評価する。
 * medianBassTotal は曲全体の低域フレーム総量の中央値（呼び出し側で 1 回計算）。
 */
export function assessCollapseSignature(
  segment: ChordSegment,
  upperChromaFrames: Float32Array[],
  bassFrames: Float32Array[],
  medianBassTotal: number,
  energies: Float32Array,
  frameDuration: number,
): CollapseAssessment | null {
  const parsed = parseChordName(segment.chord);
  if (!parsed) return null; // N.C. は対象外
  const startIdx = Math.floor(segment.start / frameDuration);
  const endIdx = Math.max(startIdx + 1, Math.ceil(segment.end / frameDuration));
  const ev = assessSegmentBass(
    bassFrames,
    medianBassTotal,
    startIdx,
    endIdx,
    bassFrames.length,
  );
  const candidate = bestChordFromBand(upperChromaFrames, energies, startIdx, endIdx);
  const detectedUpperScore = candidate
    ? chordChromaScore(
        upperChromaFrames,
        energies,
        startIdx,
        endIdx,
        parsed.root,
        parsed.mode,
      )
    : 0;
  const upperBandGap = candidate ? candidate.score - detectedUpperScore : 0;
  return {
    fires: collapseSignatureFires({
      bassStrong: ev.strong,
      bassTopPc: ev.topPc,
      detectedRoot: parsed.root,
      candidate,
      upperBandGap,
    }),
    candidate,
    upperBandGap,
    bassStrong: ev.strong,
    bassTopPc: ev.topPc,
  };
}

/**
 * 崩壊シグネチャのあるセグメントだけ、ルート＋モードを上帯域候補で
 * 決め直した新しい配列を返す（入力は変更しない）。
 * bassPc は保持する: 発火条件 4 により、ベース音は新ルートの構成音に
 * なっているため、表示側（lib/chordDisplay.ts）で分数表示になる。
 */
export function applyConditionalUpperRoot(
  segments: ChordSegment[],
  upperChromaFrames: Float32Array[],
  bassFrames: Float32Array[],
  energies: Float32Array,
  frameDuration: number,
): ChordSegment[] {
  const medianBassTotal = medianLowBandFrameTotal(bassFrames);
  return segments.map((seg) => {
    const a = assessCollapseSignature(
      seg,
      upperChromaFrames,
      bassFrames,
      medianBassTotal,
      energies,
      frameDuration,
    );
    if (!a || !a.fires || !a.candidate) return seg;
    return { ...seg, chord: chordName(a.candidate.root, a.candidate.mode) };
  });
}

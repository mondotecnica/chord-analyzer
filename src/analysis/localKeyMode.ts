import { chordName } from "../lib/notes";
import type { ChordSegment } from "../types";
import { chordChromaScore, parseChordName } from "./bassCorrection";
import {
  chordKeyPlausibility,
  keyScalePcs,
  localKeyWindowAt,
  type LocalKeyContext,
} from "./localKey";

/**
 * Phase 3.3: 第1段のモード決定への局所キー prior（柔らかい重みのみ）。
 * 計画: PHASE3_PLAN.md §3.3＋§6 追記、理論レイヤーの規則は §2。
 *
 * 背景（PHASE3_1_RESULTS.md の失敗分析1）: 第2段は第1段の major/minor を
 * 信頼する設計のため、第1段のモード誤り（例: Suno 05 Q2 窓で局所的に
 * E♭ > E♮ となり Cm と読む）は第2段では直せない。Q2 基準は 3.3 へ
 * 移され、本モジュールがその受け皿になる。
 *
 * 機構（セグメント単位、ルート・境界・信頼度・bassPc は変えない）:
 * - 上帯域クロマ（第1段のモード決め直しと同じ証拠）で、そのルートの
 *   major/minor スコアを再計算し、現在のモードとのマージンを得る。
 * - マージンが maxOverridableMargin より大きいセグメントは**絶対に
 *   触らない**（prior が覆せるのは音響的に接戦の場合だけ。これが
 *   「借用コードを残す」ための上限として働く）。
 * - 接戦の場合のみ、局所キー（セグメント中点の窓。無ければ全体キー）
 *   における両モードの尤もらしさ（chordKeyPlausibility）の差に比例した
 *   bonus（上限 priorCap × gap）を対抗モードのスコアに加え、
 *   それでも逆転する場合に限ってモードを反転させる。
 * - 窓がある場合、次点キー（推定器が報告する第二の解釈）の下でも
 *   対抗モードが有利であることを必須とする。次点キーが無関心
 *   （gap = 0）な反転は、最有力キーの解釈だけに依存した危うい
 *   反転であり、実測でも有害な反転は全てこの形だった。
 * - bassPc がルートと異なり、どちらのモードの構成音でもない
 *   セグメントは対象外にする。そのようなセグメントはルート自体が
 *   未確定（分数／第2段の再解釈の守備範囲）であり、モード prior で
 *   触るべきではない（Suno Q3 の B7 ハイジャック対象セグメントが
 *   この形で、実際に保護が要ることを調整時に確認した）。
 * - 二次ドミナント保護: 長三和音で、その完全4度上のルートが局所
 *   キーのスケール音であるもの（= 二次ドミナントとして説明できる
 *   形）は minor へ反転させない。長三和音は I／V のような
 *   ダイアトニックな位置では尤もらしさ自体が最大で元々反転しない
 *   ため、major→minor の反転候補は実質この形か「キーと無関係な
 *   コード」しか残らない。前者は借用の正当な語彙であり、prior で
 *   消すべきではない（実測根拠は PHASE3_3_RESULTS.md）。
 * - N.C. とユーザー修正済み（edited）セグメントは対象外。
 *   ハードなダイアトニックフィルタは入れない（候補の除外はしない、
 *   あくまで接戦のスコアに小さな重みを足すだけ）。
 */

/**
 * しきい値（2026-10-28、合成曲 A–F と Suno フィクスチャで調整し、
 * 実曲 1–3 には触れずに検証する。調整の記録は
 * measurements/phase3/PHASE3_3_RESULTS.md）。
 *
 * 根拠（調整時の実測）:
 * - Suno Q2 の Cm セグメント（stems）の音響マージンは 0.013 と
 *   0.194。後者を覆せる必要があるため maxOverridableMargin は
 *   0.22、priorCap は gap 1/3 でも bonus が 0.20 を超える 0.65 に置く。
 * - 初版（上限＋尤もらしさ差のみ）では実曲で有害な反転が量産され、
 *   その内訳分析から二次ドミナント保護と次点キー支持の必須化を
 *   追加した。経緯と数値は PHASE3_3_RESULTS.md に記録する。
 */
export const LOCAL_KEY_MODE_CONFIG = {
  /** prior が覆せる音響マージンの上限（コサインスコア差） */
  maxOverridableMargin: 0.22,
  /** bonus の上限 = priorCap × plausibilityGap（gap は最大 1） */
  priorCap: 0.65,
} as const;

export interface ModeNudgeVerdict {
  /** 反転させる場合の新しいモード。させない場合は undefined */
  flipTo?: "major" | "minor";
  /** 現在モード − 対抗モードの音響スコア差（符号付き） */
  audioMargin: number;
  /** 局所キー下での尤もらしさの差（対抗 − 現在） */
  plausibilityGap: number;
  /** 実際に加えた bonus */
  bonus: number;
}

/**
 * 1 セグメント分の nudge 判定（純粋関数、単体テスト対象）。
 * scores は呼び出し側が証拠クロマで計算した major/minor スコア。
 */
export function judgeModeNudge(
  root: number,
  currentMode: "major" | "minor",
  majorScore: number,
  minorScore: number,
  bassPc: number | undefined,
  ctx: LocalKeyContext,
  segmentMidSec: number,
): ModeNudgeVerdict {
  const altMode = currentMode === "major" ? "minor" : "major";
  const curScore = currentMode === "major" ? majorScore : minorScore;
  const altScore = currentMode === "major" ? minorScore : majorScore;
  const audioMargin = curScore - altScore;
  const base: ModeNudgeVerdict = {
    audioMargin,
    plausibilityGap: 0,
    bonus: 0,
  };

  if (audioMargin > LOCAL_KEY_MODE_CONFIG.maxOverridableMargin) return base;

  // ベースがルートと食い違い、どちらのモードの構成音でもない場合は
  // ルート自体が未確定とみなして触らない
  if (bassPc !== undefined) {
    const bass = ((bassPc % 12) + 12) % 12;
    if (bass !== root) {
      const tones = new Set([
        root,
        (root + 3) % 12,
        (root + 4) % 12,
        (root + 7) % 12,
      ]);
      if (!tones.has(bass)) return base;
    }
  }

  const win = localKeyWindowAt(ctx, segmentMidSec);
  const bestKey = win
    ? { root: win.root, mode: win.mode }
    : { root: ctx.global.root, mode: ctx.global.mode };

  // 二次ドミナント保護: 現在のコードが長三和音で、その完全4度上の
  // ルート（解決先）が局所キーのスケール音である場合、そのコードは
  // 二次ドミナントとしてキー内で正当に説明できる（計画 §2 は
  // 二次ドミナントを prior の材料として明示的に認めている）。
  // この形の長三和音を minor へ反転させない。実測の根拠
  // （PHASE3_3_RESULTS.md）: 初版で観測された有害な major→minor
  // 反転（Song E の B7、Song F の A7、Song B の D、実曲の A/F#/D 等）
  // は全てこの形であり、有益な反転は全て minor→major 方向だった。
  if (currentMode === "major") {
    const target = (root + 5) % 12;
    if (keyScalePcs(bestKey.root, bestKey.mode).has(target)) return base;
  }

  const gapBest =
    chordKeyPlausibility(root, altMode, bestKey.root, bestKey.mode) -
    chordKeyPlausibility(root, currentMode, bestKey.root, bestKey.mode);
  if (gapBest <= 0) return { ...base, plausibilityGap: gapBest };

  // 次点キーの支持を必須とする: 窓がある場合、その次点キー（推定器
  // 自身が報告する第二の解釈）の下でも対抗モードが有利でなければ
  // 反転しない。実測の根拠（PHASE3_3_RESULTS.md）: 有害だった反転
  // （実曲1 stems の Dm(maj7) 区間 → D 化、Em → E 化）は全て
  // 次点キーが無関心（gap = 0）か反対（gap < 0）であり、有益な
  // 反転（Q2 の Cm → C、合成曲の Gm → G）は全て次点キーも
  // 支持していた（gap = +0.364）。「推定器が曖昧さを報告している
  // 文脈では、prior はその曖昧さのどちら側でも成り立つ場合にだけ
  // 効く」という §2 の考え方（曖昧さには尤度で応じる）の具体化。
  if (win) {
    const gapRunnerUp =
      chordKeyPlausibility(root, altMode, win.runnerUpRoot, win.runnerUpMode) -
      chordKeyPlausibility(root, currentMode, win.runnerUpRoot, win.runnerUpMode);
    if (gapRunnerUp <= 0) return { ...base, plausibilityGap: gapBest };
  }

  const bonus = LOCAL_KEY_MODE_CONFIG.priorCap * gapBest;
  if (altScore + bonus > curScore) {
    return { flipTo: altMode, audioMargin, plausibilityGap: gapBest, bonus };
  }
  return { ...base, plausibilityGap: gapBest, bonus };
}

/**
 * セグメント列に局所キー nudge を適用した新しい配列を返す
 * （入力は変更しない）。modeChromaFrames は第1段のモード決め直しと
 * 同じ証拠クロマ（混合音経路・ステム経路とも上帯域クロマ）を渡す。
 */
export function applyLocalKeyModeNudge(
  segments: ChordSegment[],
  modeChromaFrames: Float32Array[],
  energies: Float32Array,
  frameDuration: number,
  ctx: LocalKeyContext,
): ChordSegment[] {
  return segments.map((seg) => {
    if (seg.edited) return seg;
    const parsed = parseChordName(seg.chord);
    if (!parsed) return seg; // N.C. は対象外
    const startIdx = Math.floor(seg.start / frameDuration);
    const endIdx = Math.max(startIdx + 1, Math.ceil(seg.end / frameDuration));
    const majorScore = chordChromaScore(
      modeChromaFrames,
      energies,
      startIdx,
      endIdx,
      parsed.root,
      "major",
    );
    const minorScore = chordChromaScore(
      modeChromaFrames,
      energies,
      startIdx,
      endIdx,
      parsed.root,
      "minor",
    );
    const verdict = judgeModeNudge(
      parsed.root,
      parsed.mode,
      majorScore,
      minorScore,
      seg.bassPc,
      ctx,
      (seg.start + seg.end) / 2,
    );
    if (!verdict.flipTo) return seg;
    return { ...seg, chord: chordName(parsed.root, verdict.flipTo) };
  });
}

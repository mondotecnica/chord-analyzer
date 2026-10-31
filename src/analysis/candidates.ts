import { NO_CHORD } from "../lib/notes";
import type { ChordSegment, SegmentCandidate } from "../types";
import { chordChromaScore, parseChordName } from "./bassCorrection";
import { CHORD_TEMPLATES } from "./chordEstimation";

/**
 * Theory Engine 第1段: 候補リストの露出（THEORY_ENGINE_DESIGN.md §2）。
 *
 * 役割: 確定済みセグメント列に対して、セグメントごとの上位 k 候補
 * （三和音コア 24 通り）を加算的に付ける純粋な後段モジュール。
 * 判定には一切触れない（入力セグメントの chord / bassPc / 境界 /
 * 信頼度はそのまま）。オプション（candidateRecord）が有効な場合に
 * だけ両経路（analyze.ts / analyzeStems.ts）の最終段から呼ばれる。
 *
 * 候補スコアの定義（「そのセグメントの集約証拠が実際に付けたスコア」）:
 * - 集計 = コード判定用クロマ（上帯域 chordFrames）のセグメント区間
 *   エネルギー加重平均。スコア = その集計ベクトルと各テンプレートの
 *   コサイン類似度（bassCorrection.ts の chordChromaScore、そのまま）。
 * - この集計は、既定経路の最後の (root, mode) 判定である「モード
 *   決め直し」（splitBand.ts）と、第2段（拡張音検出、
 *   extensionDetection.ts）が証拠として使うのと同じものである。
 *   実測（measurements/theory/THEORY_ENGINE_STEP1.md のプローブ）:
 *   この集計では「確定ルート内で確定モードが argmax」である率が
 *   全スイートで 100%（構造どおり）であり、同ルートの代替候補が
 *   勝者を上回ることは無い。一方、どちらの単一集計（全帯域／
 *   上帯域）でも確定ラベルが全体の argmax になる率は実曲で
 *   4〜5 割にとどまる。確定ルートはフレーム列の投票とベース
 *   証拠（低域分布）を含む複合判定であり、単一のクロマ集計では
 *   再現できないためである。
 * - したがって候補リストは「1位 = 確定ラベル（構成で固定）＋
 *   その他の上位代替（この集計のスコア降順）」とする。異ルートの
 *   代替が勝者を上回る場合、マージン（1位スコア − 候補スコア）は
 *   負になる。これは誤りではなく、「上帯域集計だけなら代替が
 *   勝っていた。確定ルートはフレーム列／ベース証拠に依る」という
 *   第2段が必要とする情報そのものであるため、符号を潰さず保持する。
 * - 別設定での再計算はしない: 使うクロマとエネルギーは、その実行で
 *   パイプラインが実際に使ったもの（呼び出し側が渡す chordFrames /
 *   energies）をそのまま使う。帯域戦略が unified の場合は
 *   chordFrames がフレーム判定クロマそのものであり、定義はそのまま
 *   「判定に使われた集計」になる。
 *
 * bassPc の扱い: ベース音は候補の属性ではなくセグメントの証拠
 * （低域分布）として確定するため、全候補にセグメントの bassPc を
 * そのまま載せる。第2段が候補を格上げした場合の表示名は、候補の
 * (root, mode) とこの bassPc から消費側が組み立てる。
 *
 * N.C. セグメントの扱い: 確定状態は N.C. のまま変えず、候補には
 * 「ゲートで棄却された対抗候補」の上位 k を同じ集計スコアで載せる
 * （1位は最有力の棄却候補で、マージンはその候補基準で非負）。
 * 設計書 §3 のとおり系列最適化は N.C. を候補列上の状態として含み、
 * §6.5 のとおり評価器は N.C. にラベルを発明しない — この候補列は
 * 「鳴っていたら何だったか」の記録であり、N.C. 状態そのものは
 * セグメント側が担う。
 *
 * 候補空間に含めないもの（第1段の範囲外）:
 * - 拡張音（maj7 / 7 / m7）: 語彙とスコアは第2段（拡張音検出）の
 *   内部にあり、その露出は別段の課題（引き継ぎ事項参照）。
 * - 上層候補（upperChord / upperExtension）: 設計書 §8 で未決。
 *   層表示はセグメントのフィールドとして従来どおり保持される。
 */

/** 候補件数 k の内部既定値（オプション candidateCount で上書き可能） */
export const DEFAULT_CANDIDATE_COUNT = 5;

/** 候補スコアの証拠（呼び出し側がその実行で実際に使ったものを渡す） */
export interface CandidateChromaSource {
  /** コード判定用クロマ（上帯域 chordFrames） */
  frames: Float32Array[];
  /** フレームエネルギー列（判定経路のもの） */
  energies: Float32Array;
  frameDuration: number;
}

interface ScoredTemplate {
  root: number;
  mode: "major" | "minor";
  score: number;
  /** CHORD_TEMPLATES 内の順序（同点時の決定的なタイブレーク） */
  order: number;
}

function clampCount(count: number | undefined): number {
  if (count === undefined || !Number.isFinite(count)) {
    return DEFAULT_CANDIDATE_COUNT;
  }
  return Math.min(
    CHORD_TEMPLATES.length,
    Math.max(1, Math.floor(count)),
  );
}

/** セグメント区間の全テンプレートスコアを集計スコアの降順で返す */
function scoreAllTemplates(
  seg: ChordSegment,
  source: CandidateChromaSource,
): ScoredTemplate[] {
  const startIdx = Math.floor(seg.start / source.frameDuration);
  const endIdx = Math.max(
    startIdx + 1,
    Math.ceil(seg.end / source.frameDuration),
  );
  const scored = CHORD_TEMPLATES.map((t, order) => ({
    root: t.root,
    mode: t.mode,
    score: chordChromaScore(
      source.frames,
      source.energies,
      startIdx,
      endIdx,
      t.root,
      t.mode,
    ),
    order,
  }));
  // スコア降順、同点はテンプレート順（ルート昇順、同ルートでは
  // major → minor）で決定的に並べる
  scored.sort((a, b) => b.score - a.score || a.order - b.order);
  return scored;
}

function toCandidate(
  t: ScoredTemplate,
  topScore: number,
  bassPc: number | undefined,
): SegmentCandidate {
  return {
    root: t.root,
    mode: t.mode,
    ...(bassPc !== undefined ? { bassPc } : {}),
    score: t.score,
    margin: topScore - t.score,
  };
}

/**
 * 1 セグメント分の候補リストを作る。
 * - ラベルあり: 1位は確定ラベル（chord の root/mode）で固定し、
 *   そのスコアを基準にマージンを付ける。残りは集計スコア降順の
 *   上位（勝者を除く）。
 * - N.C.: 棄却された候補の上位 k（スコア降順、マージンは非負）。
 */
export function segmentCandidates(
  seg: ChordSegment,
  source: CandidateChromaSource,
  count?: number,
): SegmentCandidate[] {
  const k = clampCount(count);
  const scored = scoreAllTemplates(seg, source);
  const parsed = seg.chord === NO_CHORD ? null : parseChordName(seg.chord);

  if (!parsed) {
    // N.C.（または解釈不能なラベル）: 棄却候補の列として露出する
    const top = scored.slice(0, k);
    const topScore = top[0]?.score ?? 0;
    return top.map((t) => toCandidate(t, topScore, seg.bassPc));
  }

  const winner = scored.find(
    (t) => t.root === parsed.root && t.mode === parsed.mode,
  )!;
  const alternatives = scored
    .filter((t) => t !== winner)
    .slice(0, Math.max(0, k - 1));
  return [
    toCandidate(winner, winner.score, seg.bassPc),
    ...alternatives.map((t) => toCandidate(t, winner.score, seg.bassPc)),
  ];
}

/**
 * 確定セグメント列に候補リストを加算的に付けた新しい配列を返す
 * （入力は変更しない）。候補以外のフィールドは一切変えない。
 */
export function attachSegmentCandidates(
  segments: ChordSegment[],
  source: CandidateChromaSource,
  count?: number,
): ChordSegment[] {
  return segments.map((seg) => ({
    ...seg,
    candidates: segmentCandidates(seg, source, count),
  }));
}

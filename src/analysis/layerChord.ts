import { chordName } from "../lib/notes";
import type { ChordSegment } from "../types";
import { parseChordName } from "./bassCorrection";
import {
  bestTemplateCandidate,
  EXTENSION_CONFIG,
  segmentEvidence,
  seventhPcOf,
  seventhTemplateFit,
  triadTemplateFit,
  type TemplateCandidate,
} from "./extensionDetection";
import type { ChordExtension } from "../types";

/**
 * Phase 3.2: 分数コードの上層の再読（PHASE3_PLAN.md §3.2）。
 *
 * 背景: ベース補正は「強いベース証拠があればルートをベース音に合わせる」
 * ため、補正が発火したセグメントでは、和声側の読み（例: Am）は
 * ベース音側のコード（例: Dm）に潰れてしまう。Phase 3.2 では補正前の
 * 読みを upperChord として保持する（bassCorrection.ts）が、保持した
 * 読みが常に「上層」として正しいとは限らない。補正が治した相対調の
 * 取り違え（例: Em の小節を G と読んだ）では、フレーム側の読みこそ
 * 誤りであり、それを層として復活させてはならない。逆に Suno 05 の
 * Q1／Q4 のように、補正後のコード（Dm／C#m）では音集合を説明
 * できない場合は、響きは実際に層になっている。
 *
 * 本モジュールは、潰れたセグメント（upperChord を持つもの）だけを
 * 対象に、セグメント集計証拠で「層が実在するか」を判定し、実在する
 * 場合のみ上層を再読する:
 *
 * - 証拠クロマは呼び出し側が渡す。混合音経路は上帯域クロマ
 *   （chordFrames）: 混合音の全帯域は低域の FFT ビン分解能不足で
 *   ベース基音が ±1 半音へ滲み（例: E2 基音が F／D のビンへ）、
 *   実在しない音でテンプレート適合が歪むため。ステム経路は
 *   other ステムの全帯域クロマ: 分離後の other の低域は実在の
 *   ルート情報を含み（STEM_BAND_AB の知見）、ベース楽器は別ステム
 *   にいるため滲みの主因がない。Q4 の C／A の証拠は other の
 *   低域側にあり、上帯域では拾えない。
 * - 層の実在ゲート: 補正後コード（chord）の三和音が証拠集計に
 *   対して「よく適合してしまう」場合は層とはみなさない
 *   （相対調の取り違えを補正が正しく治した形）。補正後コードの
 *   適合度が低く、表示される上層の適合度がそれを大きく上回る
 *   場合にだけ層を残す。さらに、証拠がベース音ルートのコードを
 *   表示上層より強く支持する場合も層とはみなさない（響きは
 *   ベース音のコードそのものであり、モードの当否は第1段の
 *   守備範囲）。ゲートを通らなければ upperChord /
 *   upperExtension を落とし、表示は補正後コードに戻る。
 * - 上層の再読: ベース音のピッチクラスを 0 にした集計シェアに対し、
 *   三和音 24 テンプレート＋第2段と同じ 7th 語彙（maj7 / 7 / m7）
 *   の最良適合を選ぶ。7th 候補の採用には第2段と同じ床
 *   （シェア下限・持続性・三和音からの適合度改善）を課す
 *   （EXTENSION_CONFIG を流用）。候補のルートがベース音と一致
 *   する場合は採用しない（上層は定義上ベース音をルートに持たない）。
 * - 再読結果への置き換えは、保持済みの読みの適合度を
 *   minFitImprovement 以上上回る場合のみ。それ以外は保持済みの
 *   読みのままにする。
 *
 * 本モジュールが触るのは upperChord / upperExtension の2フィールド
 * だけであり、第1段・第2段の出力（chord / extension / bassPc /
 * 境界 / 信頼度）は一切変更しない。N.C. とユーザー修正済み
 * （edited）セグメントは対象外。
 *
 * 原理的限界（計画 §3.2 の再確認）: C6 と Am7 のように構成音が
 * 完全に同じ組は音だけでは区別できず、本モジュールのテンプレート
 * 適合でも同点になる。その場合は三和音側（C）が残り、分数表示は
 * C/D の形になる。文脈（前後進行・キー）での最終判断は人間に残る。
 */

/**
 * 層の実在ゲートのしきい値（2026-10-28、合成曲＋Suno フィクスチャで
 * 調整し、実曲は検証専用。分布の実測は PHASE3_2_RESULTS.md）:
 * - 補正後コードの三和音適合度の上限: 真の層（Suno Q1 = 0.22〜0.33、
 *   Q4 = 0.63）を通し、相対調の取り違え側（合成の誤層で 0.71〜0.76
 *   が中心）を落とす位置として 0.65。
 * - 適合度差の下限: 比較相手は補正後コードの「7th 込み」適合度
 *   （correctedExplainedFit）。補正後コードに 7th を足すと集計を
 *   説明できてしまう場合は、上層は補正後コード自身の 7 度音の
 *   誤読である可能性が高い（実例: Suno Q3 の解決部で Am の ♭7
 *   である G が上層に立つケースは差 0.054、真の層である Q4 は
 *   C#m7 込みでも差 0.096）。両者を分ける位置として 0.06。
 *   境界近傍の分離であることは PHASE3_2_RESULTS.md に明記する。
 */
export const LAYER_GATE_CONFIG = {
  /** 補正後コードの三和音適合度（証拠集計・生シェア）の上限 */
  maxCorrectedFit: 0.65,
  /** 上層の適合度 − 補正後コードの 7th 込み適合度 の下限 */
  minFitGap: 0.06,
  /**
   * 再読で maj7 候補を採用するための 7 度音シェアの下限。
   * 第2段の床（0.10）より高く置く: 合成 Song D の G メジャー小節では
   * 3 度音 B の3倍音が F#（長7度）として 0.122 まで観測され、
   * 第2段の床では GM7 と誤読した。真の maj7（Suno Q4 の B）は
   * 0.158〜0.166 あり、その間を分ける位置として 0.14。
   */
  minMaj7ShareReRead: 0.14,
} as const;

/**
 * 補正後コードが証拠集計をどの程度説明できるか（三和音＋、第2段の
 * 床を満たす 7th テンプレートの最大値）。ゲートの比較相手に使う。
 */
function correctedExplainedFit(
  ev: { shares: Float32Array; persistence: Float32Array },
  root: number,
  mode: "major" | "minor",
): number {
  let fit = triadTemplateFit(ev.shares, root, mode);
  const candidates: ChordExtension[] = mode === "major" ? ["maj7", "7"] : ["m7"];
  for (const ext of candidates) {
    const pc = seventhPcOf(root, ext);
    const floor =
      ext === "maj7" ? EXTENSION_CONFIG.minMaj7Share : EXTENSION_CONFIG.minSeventhShare;
    if (ev.shares[pc] < floor) continue;
    if (ev.persistence[pc] < EXTENSION_CONFIG.minPersistence) continue;
    fit = Math.max(fit, seventhTemplateFit(ev.shares, root, ext));
  }
  return fit;
}

export function applyUpperLayerReRead(
  segments: ChordSegment[],
  evidenceFrames: Float32Array[],
  energies: Float32Array,
  frameDuration: number,
): ChordSegment[] {
  return segments.map((seg) => {
    if (seg.edited || seg.upperChord === undefined || seg.bassPc === undefined) {
      return seg;
    }
    const preserved = parseChordName(seg.upperChord);
    const corrected = parseChordName(seg.chord);
    if (!preserved || !corrected) return seg;
    const bass = ((seg.bassPc % 12) + 12) % 12;

    const startIdx = Math.floor(seg.start / frameDuration);
    const endIdx = Math.max(startIdx + 1, Math.ceil(seg.end / frameDuration));
    const ev = segmentEvidence(evidenceFrames, energies, startIdx, endIdx);
    if (!ev) return seg;

    // ベース層の音を上層の証拠から外す（コサインはスケール不変なので
    // 再正規化は不要）
    const shares = Float32Array.from(ev.shares);
    shares[bass] = 0;

    const { best, bestTriad } = bestTemplateCandidate(shares);
    let candidate: TemplateCandidate = best;
    // 上層のルートがベース音になる候補は採用しない
    if (candidate.root === bass) candidate = bestTriad;
    // 7th 候補には床を課す（maj7 は再読専用の高めの床、その他は
    // 第2段と同じ床）
    if (candidate.root !== bass && candidate.extension) {
      const pc = seventhPcOf(candidate.root, candidate.extension);
      const floor =
        candidate.extension === "maj7"
          ? LAYER_GATE_CONFIG.minMaj7ShareReRead
          : EXTENSION_CONFIG.minSeventhShare;
      if (
        pc === bass ||
        ev.shares[pc] < floor ||
        ev.persistence[pc] < EXTENSION_CONFIG.minPersistence ||
        candidate.fit - bestTriad.fit < EXTENSION_CONFIG.minFitImprovement
      ) {
        candidate = bestTriad;
      }
    }

    // 表示される上層（置き換え判定の結果）を先に決め、その適合度で
    // ゲートを評価する（表示されない候補の適合度で層の実在を
    // 主張しない）。保持済みの読みに 7th が付いている場合は
    // 7th テンプレートで適合度を測る。
    const preservedFit = seg.upperExtension
      ? seventhTemplateFit(shares, preserved.root, seg.upperExtension)
      : triadTemplateFit(shares, preserved.root, preserved.mode);
    const sameChord =
      candidate.root === preserved.root && candidate.mode === preserved.mode;
    const replace =
      candidate.root !== bass &&
      !(sameChord && candidate.extension === undefined) &&
      candidate.fit >= preservedFit + EXTENSION_CONFIG.minFitImprovement;
    const displayedFit = replace ? candidate.fit : preservedFit;

    // 層の実在ゲート: 補正後コード（7th 込み）が集計証拠をよく
    // 説明できている場合は、保持済みの読みは相対調の取り違えや
    // 補正後コード自身の 7 度音の誤読であり、層として残さない
    // （upperChord を落として従来表示に戻す）。また、証拠が
    // ベース音ルートのコードを強く支持する場合は、響きは
    // 「ベース音のコードそのもの」であって層ではないので、
    // 同じく層を落とす（モード違いは第1段の守備範囲）。
    const correctedTriadFit = triadTemplateFit(
      ev.shares,
      corrected.root,
      corrected.mode,
    );
    const correctedFit = correctedExplainedFit(ev, corrected.root, corrected.mode);
    const bassCandidateFit = Math.max(
      best.root === bass ? best.fit : -Infinity,
      bestTriad.root === bass ? bestTriad.fit : -Infinity,
    );
    if (
      correctedTriadFit > LAYER_GATE_CONFIG.maxCorrectedFit ||
      displayedFit - correctedFit < LAYER_GATE_CONFIG.minFitGap ||
      bassCandidateFit > displayedFit + LAYER_GATE_CONFIG.minFitGap
    ) {
      const next: ChordSegment = { ...seg };
      delete next.upperChord;
      delete next.upperExtension;
      return next;
    }
    if (!replace) return seg;

    const next: ChordSegment = {
      ...seg,
      upperChord: chordName(candidate.root, candidate.mode),
    };
    if (candidate.extension) next.upperExtension = candidate.extension;
    else delete next.upperExtension;
    return next;
  });
}

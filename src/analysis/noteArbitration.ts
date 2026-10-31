import { chordName, NO_CHORD } from "../lib/notes";
import type {
  ChordSegment,
  NoteArbitrationRationale,
  SegmentCandidate,
} from "../types";
import { parseChordName } from "./bassCorrection";
import { triadExplained } from "./noteEvidence";
import {
  selectSegmentEvidence,
  type NoteSelectionInput,
  type SelectedSegmentEvidence,
} from "./noteEvidenceSelection";
import {
  diatonicFeature,
  emission,
  isProtected,
  keyFeature,
  resolveKeyContext,
  transitionFeature,
  THEORY_WEIGHTS_V2,
  type TheoryProfile,
} from "./theoryReevaluation";

/**
 * 音符仲裁を主軸にした再評価器（設計と測定:
 * measurements/theory/THEORY_ENGINE_NOTE_ARBITRATION.md）。
 *
 * 位置づけ: Theory Engine 第2段（v1/v2）は「接戦で上帯域集計と
 * 複合判定のどちらが正しいかを言い当てる第三の証拠が現行入力に
 * 存在しない」ことを拘束条件として閉じた（STEP2_RETRY.md §5）。
 * その後、音符レベルの選択済み証拠が第三の証拠として実測で
 * 成立した（EVIDENCE_SELECTION.md: 勝者と集計 argmax が割れた
 * 接戦の二択で正解率 0.745、集計 0.357／勝者 0.643 を上回る）。
 * 本モジュールは、その再開条件 (a) の充足を受けて設計した
 * 新しい消費者であり、理論主軸だった v1/v2 とは主従が逆である:
 *
 * - 主軸 = 音符仲裁: 割れている／接戦のセグメントでのみ、
 *   選択済み音符証拠（noteEvidenceSelection.ts、両機構 ON の
 *   既定構成）の三和音説明率で現ラベルと挑戦者を比較し、
 *   差が事前登録した閾値（noteFlipDelta）を超えた場合だけ
 *   反転する。EVIDENCE_SELECTION の仲裁診断（§2.2）を、その
 *   まま消費者の決定規則に形式化したものである。
 * - 理論は補助: 音符証拠が棄権した接戦に限り、凍結した v2
 *   構成（THEORY_WEIGHTS_V2、数値は一切変えない）を
 *   タイブレーカーとして使う。適用は pairwise 形（隣接ラベルを
 *   音符段の確定ラベルに固定した二択評価）に制限する。v2 の
 *   Viterbi そのものではない（系列全体の再最適化はしない）が、
 *   ノード／エッジの意味論と数値は v2 と同一である。
 *
 * 発火条件と否定保護（作用範囲を構造で bound する設計）:
 * - 対象は「挑戦者 = 候補列の2位（candidates[1]）」のマージンが
 *   接戦帯（nearTieMargin = 0.06）以内にあるセグメントだけ。
 *   第1段の候補列は「1位 = 確定ラベル、残りは集計スコア降順」
 *   という順序が保証されているため、集計 argmax は
 *   candidates[1] そのもの（マージン < 0 のとき）か勝者自身
 *   であり、「勝者と argmax が割れている」ことと「2位が
 *   接戦帯にいる」ことはこの1条件に帰着する。接戦帯 0.06 は
 *   v1/v2 の emission 接戦域（emissionClamp）と同値・同根拠
 *   （実曲のマージン分布プローブ。結果文書 §2）。
 * - **否定保護**: 格上げできるのは candidates[1] だけであり、
 *   3位以下の候補は、音符証拠がどれだけ強く支持しても単独では
 *   復活させない。あわせて、2位であってもマージンが接戦帯を
 *   超える（= 集計が現ラベルを明確に支持する）候補は対象外。
 *   Q2 の Cm はこの設計で構造的に防がれる: stems-05 の Q2 窓で
 *   現ラベルが Am のセグメントでは Cm は候補列の4位（集計
 *   argmax は C）であり、挑戦者の席に着けない。現ラベルが
 *   Cm 自身のセグメントでは、音符証拠は Cm を支持側に回る
 *   ため反転は起きず、baseline の読みがそのまま残る（増えは
 *   しない）。検証の数値は結果文書 §2／§4。
 * - 音符の棄権: 証拠が無い（pcWeights が null）か、選択の
 *   フォールバックが発動したセグメントでは音符は棄権し、
 *   反転しない（理論補助の対象にはなる）。説明率が同点
 *   （差 0）の場合も棄権として扱う。音符が弱く支持／反対した
 *   （差が閾値以下だが 0 でない）場合は「発言したが決め手に
 *   ならない」として現ラベルを維持し、理論補助も重ねない
 *   （主軸の閾値を補助で迂回しないため）。
 *
 * 反転の保護と不変条件（v1/v2 の規則を踏襲）:
 * - 反転はコアラベル（chord）のみに作用する。装飾つき
 *   セグメント（extension／upperChord／addTones／ncFill）は
 *   反転しない。bassPc・信頼度・境界・候補列は変えない。
 * - N.C. セグメントには一切触らない（ラベルを発明しない）。
 *   したがって N.C. の時間は構成上不変。
 * - オプション（noteArbitration）が OFF のときはもちろん、
 *   音符入力が無い場合は呼び出し側で完全無動作になる
 *   （analyze.ts／analyzeStems.ts の接続参照）。
 *
 * 反転したセグメントには根拠内訳（NoteArbitrationRationale）を
 * 加算的に残す。理論補助の内訳は v2 の契約に倣い、emission と
 * 現ラベル擁護（H）は合計にのみ含め、項目としては載せない。
 */

export interface NoteArbitrationConfig {
  /**
   * 接戦帯: 挑戦者（候補2位）のマージンがこの値以内なら発火
   * 対象。否定保護の帯も兼ねる（これを超える候補は格上げ
   * できない）。v1/v2 の emissionClamp と同値・同根拠。
   */
  nearTieMargin: number;
  /** 音符仲裁の反転閾値: 説明率差（挑戦者 − 現ラベル）がこれを超えたら反転 */
  noteFlipDelta: number;
  /** 理論補助を使うか。主構成は true。ablation（報告のみ）で false */
  theoryAssist: boolean;
}

/** 主構成（較正の根拠は結果文書 §2。評価スイートの正解では決めていない） */
export const NOTE_ARBITRATION_CONFIG: NoteArbitrationConfig = {
  nearTieMargin: 0.06,
  noteFlipDelta: 0.1,
  theoryAssist: true,
};

type TriadKey = { root: number; mode: "major" | "minor" };

interface Pending {
  index: number;
  winner: SegmentCandidate;
  challenger: SegmentCandidate;
  evidence: SelectedSegmentEvidence;
  /** 音符が使えるか（証拠あり・フォールバックなし） */
  notesUsable: boolean;
  winnerExplained: number | null;
  challengerExplained: number | null;
  noteDelta: number | null;
}

/**
 * 候補列を持つセグメント列を、音符仲裁（主軸）＋理論補助で
 * 再評価した新しい配列を返す（入力は変更しない）。音符証拠は
 * noteEvidenceSelection の既定構成（持続重み＋メロディ分離）で
 * セグメント列全体に対して選択する。
 */
export function applyNoteArbitration(
  segments: ChordSegment[],
  input: NoteSelectionInput,
  profile: TheoryProfile,
  config: NoteArbitrationConfig = NOTE_ARBITRATION_CONFIG,
): ChordSegment[] {
  if (segments.length === 0) return segments;
  const evidence = selectSegmentEvidence(segments, input);
  const weights = THEORY_WEIGHTS_V2;

  // ---- 発火対象の抽出と音符段 -------------------------------------------
  const flips = new Map<number, NoteArbitrationRationale>();
  const abstained: Pending[] = [];
  // 音符段の後のラベル列（理論段の隣接文脈。N.C. は null）
  const labelsAfterNotes: (TriadKey | null)[] = segments.map((seg) => {
    const p = seg.chord === NO_CHORD ? null : parseChordName(seg.chord);
    return p ? { root: p.root, mode: p.mode } : null;
  });

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.chord === NO_CHORD) continue;
    const cands = seg.candidates;
    if (!cands || cands.length < 2) continue;
    if (isProtected(seg)) continue;
    const winner = cands[0];
    const parsed = parseChordName(seg.chord);
    if (!parsed || parsed.root !== winner.root || parsed.mode !== winner.mode) {
      continue; // 候補列の1位と現ラベルが一致しない列には作用しない
    }
    const challenger = cands[1];
    // 発火条件 兼 否定保護: 挑戦者は2位のみ、マージンは接戦帯以内
    if (challenger.margin > config.nearTieMargin) continue;

    const ev = evidence[i];
    const usable = ev.pcWeights !== null && !ev.provenance.fallback;
    const winnerExplained = usable
      ? triadExplained(ev.pcWeights!, winner.root, winner.mode)
      : null;
    const challengerExplained = usable
      ? triadExplained(ev.pcWeights!, challenger.root, challenger.mode)
      : null;
    const noteDelta =
      winnerExplained !== null && challengerExplained !== null
        ? challengerExplained - winnerExplained
        : null;
    const pending: Pending = {
      index: i,
      winner,
      challenger,
      evidence: ev,
      notesUsable: usable,
      winnerExplained,
      challengerExplained,
      noteDelta,
    };

    if (usable && noteDelta !== null && noteDelta > config.noteFlipDelta) {
      flips.set(i, {
        fromRoot: winner.root,
        fromMode: winner.mode,
        source: "notes",
        acousticMargin: challenger.margin,
        winnerExplained,
        challengerExplained,
        noteDelta,
      });
      labelsAfterNotes[i] = { root: challenger.root, mode: challenger.mode };
    } else if (usable && noteDelta !== null && noteDelta !== 0) {
      // 音符が発言したが決め手にならない（弱い支持／反対）。
      // 現ラベルを維持し、理論補助も重ねない
      continue;
    } else {
      // 棄権: 証拠なし／フォールバック／説明率が同点
      abstained.push(pending);
    }
  }

  // ---- 理論段（補助）: 棄権した接戦だけ、凍結した v2 構成で pairwise に --
  if (config.theoryAssist) {
    for (const p of abstained) {
      const i = p.index;
      const seg = segments[i];
      const ctx = resolveKeyContext(seg, profile, weights.keyGate);
      const w = p.winner;
      const c = p.challenger;
      const keyTerm = ctx.keySilent
        ? 0
        : weights.key * (keyFeature(c.root, c.mode, ctx) - keyFeature(w.root, w.mode, ctx));
      const diaTerm =
        weights.diatonic *
        (diatonicFeature(c.root, c.mode, profile) -
          diatonicFeature(w.root, w.mode, profile));
      const prev = i > 0 ? labelsAfterNotes[i - 1] : null;
      const transPrev = prev
        ? weights.transition *
          (transitionFeature(prev, c, ctx.root, ctx.mode) -
            transitionFeature(prev, w, ctx.root, ctx.mode))
        : 0;
      const next = i < segments.length - 1 ? labelsAfterNotes[i + 1] : null;
      let transNext = 0;
      if (next) {
        const nextCtx = resolveKeyContext(segments[i + 1], profile, weights.keyGate);
        transNext =
          weights.transition *
          (transitionFeature(c, next, nextCtx.root, nextCtx.mode) -
            transitionFeature(w, next, nextCtx.root, nextCtx.mode));
      }
      // v2 のノード意味論: 挑戦者の優位 = emission（floored）＋
      // キー＋ダイアトニック − 現ラベル擁護 H ＋ 両隣の遷移差。
      // 反転は優位が厳密に正の場合だけ（v2 のタイブレーカー原則）
      const advantage =
        emission(c.margin, weights) +
        keyTerm +
        diaTerm -
        (weights.homeAdvantage ?? 0) +
        transPrev +
        transNext;
      if (advantage > 0) {
        flips.set(i, {
          fromRoot: w.root,
          fromMode: w.mode,
          source: "theory",
          acousticMargin: c.margin,
          winnerExplained: p.winnerExplained,
          challengerExplained: p.challengerExplained,
          noteDelta: p.noteDelta,
          theory: {
            key: keyTerm,
            diatonic: diaTerm,
            transitionPrev: transPrev,
            transitionNext: transNext,
          },
        });
      }
    }
  }

  if (flips.size === 0) return segments;
  return segments.map((seg, i) => {
    const rationale = flips.get(i);
    if (!rationale) return seg;
    const challenger = seg.candidates![1];
    return {
      ...seg,
      chord: chordName(challenger.root, challenger.mode),
      noteArbitrationRationale: rationale,
    };
  });
}

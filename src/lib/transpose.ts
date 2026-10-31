import {
  NO_CHORD,
  noteNameSpelled,
  parseNoteName,
  type SpellingFamily,
} from "./notes";
import type {
  AnalysisResult,
  ChordSegment,
  LocalKeyWindow,
} from "../types";

/**
 * キートランスポーズ（移調表示）の純関数モジュール。
 *
 * 解析結果そのものは書き換えず、表示・書き出し用に「移調した結果」を
 * 導出するための変換だけを担う（解析パイプラインには接続しない）。
 * UI（App.tsx）は元の結果を保持したまま、本モジュールの返す移調済み
 * 結果を表示・書き出しに使い、移調量 0 では元の結果オブジェクトを
 * そのまま返すことで従来挙動と完全一致させる。
 *
 * ## 変換対象
 * - セグメント: chord / upperChord のルート、bassPc、候補リストの
 *   root / bassPc、再評価の根拠内訳の fromRoot。extension /
 *   upperExtension / addTones は音程ベースの語彙なので無変換。
 *   N.C. は無変換。
 * - 全体キー（keyRoot。keyMode は不変）と局所キー窓列
 *   （root / runnerUpRoot）。
 * - ジャンル傾向・拍子推定の記録は「元の音声に対する解析の記録」
 *   であり、音名を含まない相対指標のため移調しない。
 *
 * ## スペリング規則（異名同音の決定方法）
 * 移調したラベルの音名スペルは、以下の決定的規則で一意に定める。
 *
 * 1. 移調量 ≡ 0 (mod 12) の場合は恒等変換とし、入力をそのまま返す
 *    （解析ラベルはプロジェクト慣習として一貫して ♯ 系スペルであり、
 *    0 のときに再スペルすると "A#" が "Bb" 等に化けて不変性が壊れる
 *    ため、再スペル自体を行わない）。
 * 2. 移調先キーは、曲の全体キー (keyRoot, keyMode) を移調量だけ
 *    ずらしたものとする。スペル系は移調先キーの調号で決める:
 *    同じピッチクラスのキー名候補（例: F# / Gb）のうち、調号の
 *    臨時記号数が少ない表記を採用し、同数の場合は ♯ 名を優先する
 *    （プロジェクトの既存ラベルが ♯ 系で統一されている慣習への
 *    整合を優先する選択。同数が問題になるのは F#/Gb（6つ同士）と
 *    D#m/Ebm（6つ同士）の2ケースのみで、いずれも ♯ 名が選ばれる）。
 *    具体的な対応は KEY_SPELLING 表の通り（マイナーは関係調の
 *    調号で数える。例: C minor は Eb major の調号 3♭ → "flats"）。
 * 3. 移調先キーのスペル系が決まれば、その系の音名表
 *    （♯ 系 = NOTE_NAMES、♭ 系 = FLAT_NOTE_NAMES）で全ての音名
 *    （コードルート・ベース音・キー名）を一様にスペルする。
 *    コードごとのダイアトニックな再スペル（例: Gb major における
 *    Cb）は行わない。音名表による一様スペルは既存の ♯ 系表示
 *    （NOTE_NAMES 一様適用）と同じ方式であり、規則が単純で
 *    決定的であることを優先する。
 *
 * ## カポ換算
 * 表示を −N 半音移調している場合、その表示コードの押さえ方に
 * Capo N を組み合わせると原曲のキーで鳴る。capoFretForShift は
 * capo = (−移調量) mod 12 を返し、実用範囲（1..6 フレット）にある
 * 場合のみ値を返す（0 や 7 以上は null = カポ換算を提示しない）。
 */

type KeyMode = "major" | "minor";

const mod12 = (pc: number): number => ((pc % 12) + 12) % 12;

/**
 * ピッチクラス＋モード → キー名の代表スペルとスペル系。
 * 「調号の臨時記号数が最少、同数は ♯ 優先」という上記規則の結果を
 * 表として固定したもの（実行時に数え直さない）。
 */
const KEY_SPELLING: Record<KeyMode, { name: string; family: SpellingFamily }[]> = {
  major: [
    { name: "C", family: "sharps" }, // 0: 調号なし
    { name: "Db", family: "flats" }, // 1: Db(5♭) < C#(7♯)
    { name: "D", family: "sharps" }, // 2: 2♯
    { name: "Eb", family: "flats" }, // 3: 3♭
    { name: "E", family: "sharps" }, // 4: 4♯
    { name: "F", family: "flats" }, // 5: 1♭
    { name: "F#", family: "sharps" }, // 6: F#(6♯) = Gb(6♭) → 同数で ♯ 優先
    { name: "G", family: "sharps" }, // 7: 1♯
    { name: "Ab", family: "flats" }, // 8: 4♭
    { name: "A", family: "sharps" }, // 9: 3♯
    { name: "Bb", family: "flats" }, // 10: 2♭
    { name: "B", family: "sharps" }, // 11: B(5♯) < Cb(7♭)
  ],
  minor: [
    { name: "C", family: "flats" }, // 0: Cm（関係調 Eb: 3♭）
    { name: "C#", family: "sharps" }, // 1: C#m(4♯) < Dbm(8♭)
    { name: "D", family: "flats" }, // 2: Dm(1♭)
    { name: "D#", family: "sharps" }, // 3: D#m(6♯) = Ebm(6♭) → 同数で ♯ 優先
    { name: "E", family: "sharps" }, // 4: Em(1♯)
    { name: "F", family: "flats" }, // 5: Fm(4♭)
    { name: "F#", family: "sharps" }, // 6: F#m(3♯)
    { name: "G", family: "flats" }, // 7: Gm(2♭)
    { name: "G#", family: "sharps" }, // 8: G#m(5♯) < Abm(7♭)
    { name: "A", family: "sharps" }, // 9: Am（調号なし）
    { name: "Bb", family: "flats" }, // 10: Bbm（関係調 Db: 5♭）
    { name: "B", family: "sharps" }, // 11: Bm(2♯)
  ],
};

/** キー（ピッチクラス＋モード）の代表スペル名とスペル系 */
export function keySpelling(
  root: number,
  mode: KeyMode,
): { name: string; family: SpellingFamily } {
  return KEY_SPELLING[mode][mod12(root)];
}

/** 移調後のキー。モードは変わらない */
export function transposedKey(
  root: number,
  mode: KeyMode,
  semitones: number,
): { root: number; mode: KeyMode } {
  return { root: mod12(root + semitones), mode };
}

/**
 * 移調先キーのスペル系（全体キー keyRoot/keyMode と移調量から決める）。
 * UI・書き出しがラベル全体のスペル系を揃えるために使う。
 */
export function spellingForShift(
  keyRoot: number,
  keyMode: KeyMode,
  semitones: number,
): SpellingFamily {
  const target = transposedKey(keyRoot, keyMode, semitones);
  return keySpelling(target.root, target.mode).family;
}

/**
 * コードラベル文字列の移調。ルートだけをずらし、ルートの後ろの
 * 部分（"m" 等のクオリティ表記）はそのまま保持する。
 * N.C. と解釈できないラベルは無変換で返す。
 * ラベルの入力スペルは ♯ 系・♭ 系のどちらでも受け付ける
 * （移調表示中のラベルを逆移調して元の表記に戻す用途のため）。
 */
export function transposeChordLabel(
  label: string,
  semitones: number,
  family: SpellingFamily,
): string {
  if (label === NO_CHORD) return label;
  const match = /^([A-G](?:#|b)?)(.*)$/.exec(label);
  if (!match) return label;
  const root = parseNoteName(match[1]);
  if (root === null) return label;
  return `${noteNameSpelled(root + semitones, family)}${match[2]}`;
}

const shiftPc = (pc: number, semitones: number): number =>
  mod12(pc + semitones);

/**
 * セグメント1件の移調。移調量 ≡ 0 (mod 12) の場合は入力オブジェクト
 * をそのまま返す（恒等性。不変性の保証はここが担う）。
 * 元のセグメントは変更しない（新しいオブジェクトを返す）。
 */
export function transposeSegment(
  seg: ChordSegment,
  semitones: number,
  family: SpellingFamily,
): ChordSegment {
  if (mod12(semitones) === 0) return seg;
  const next: ChordSegment = {
    ...seg,
    chord: transposeChordLabel(seg.chord, semitones, family),
  };
  if (seg.upperChord !== undefined) {
    next.upperChord = transposeChordLabel(seg.upperChord, semitones, family);
  }
  if (seg.bassPc !== undefined) {
    next.bassPc = shiftPc(seg.bassPc, semitones);
  }
  if (seg.candidates !== undefined) {
    next.candidates = seg.candidates.map((c) => ({
      ...c,
      root: shiftPc(c.root, semitones),
      ...(c.bassPc !== undefined
        ? { bassPc: shiftPc(c.bassPc, semitones) }
        : {}),
    }));
  }
  if (seg.theoryRationale !== undefined) {
    next.theoryRationale = {
      ...seg.theoryRationale,
      fromRoot: shiftPc(seg.theoryRationale.fromRoot, semitones),
    };
  }
  if (seg.noteArbitrationRationale !== undefined) {
    next.noteArbitrationRationale = {
      ...seg.noteArbitrationRationale,
      fromRoot: shiftPc(seg.noteArbitrationRationale.fromRoot, semitones),
    };
  }
  return next;
}

/** セグメント列の移調。移調量 ≡ 0 (mod 12) の場合は入力配列をそのまま返す */
export function transposeSegments(
  segments: ChordSegment[],
  semitones: number,
  family: SpellingFamily,
): ChordSegment[] {
  if (mod12(semitones) === 0) return segments;
  return segments.map((s) => transposeSegment(s, semitones, family));
}

/** 局所キー窓列の移調（root / runnerUpRoot のみ。相関等の証拠値は不変） */
export function transposeLocalKeyWindows(
  windows: LocalKeyWindow[],
  semitones: number,
): LocalKeyWindow[] {
  if (mod12(semitones) === 0) return windows;
  return windows.map((w) => ({
    ...w,
    root: shiftPc(w.root, semitones),
    runnerUpRoot: shiftPc(w.runnerUpRoot, semitones),
  }));
}

export interface TransposedResult {
  /** 移調済みの結果。移調量 ≡ 0 (mod 12) の場合は入力と同一オブジェクト */
  result: AnalysisResult;
  /** 移調先キーのスペル系。移調量 0 の場合は "sharps"（既存慣習） */
  family: SpellingFamily;
}

/**
 * 解析結果全体の移調（表示・書き出し用）。全体キー・局所キー・
 * セグメントを移調し、keyName も移調先キーの代表スペルで組み直す。
 * ジャンル傾向・拍子推定・BPM 等の記録は移調しない（モジュールの
 * 冒頭コメント参照）。移調量 ≡ 0 (mod 12) の場合は入力をそのまま
 * 含む TransposedResult を返し、従来の表示・書き出しと完全一致させる。
 */
export function transposeAnalysisResult(
  result: AnalysisResult,
  semitones: number,
): TransposedResult {
  if (mod12(semitones) === 0) {
    return { result, family: "sharps" };
  }
  const target = transposedKey(result.keyRoot, result.keyMode, semitones);
  const spelling = keySpelling(target.root, target.mode);
  const next: AnalysisResult = {
    ...result,
    keyRoot: target.root,
    keyName: `${spelling.name} ${target.mode}`,
    segments: transposeSegments(result.segments, semitones, spelling.family),
    ...(result.localKeys
      ? { localKeys: transposeLocalKeyWindows(result.localKeys, semitones) }
      : {}),
  };
  return { result: next, family: spelling.family };
}

/**
 * 表示コードの押さえ方で原曲キーを鳴らすためのカポ位置。
 * capo = (−移調量) mod 12。実用範囲（1..6）にある場合のみ返し、
 * それ以外（移調なし・下げ方向の移調でカポが深くなりすぎる場合）
 * は null（カポ換算を提示しない）。
 */
export function capoFretForShift(semitones: number): number | null {
  const capo = mod12(-semitones);
  return capo >= 1 && capo <= 6 ? capo : null;
}

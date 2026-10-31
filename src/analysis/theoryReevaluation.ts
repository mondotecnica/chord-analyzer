import { chordName, NO_CHORD } from "../lib/notes";
import type {
  ChordSegment,
  LocalKeyWindow,
  TheoryRationale,
} from "../types";

/**
 * Theory Engine 第2段: 最小の系列再評価器（THEORY_ENGINE_DESIGN.md
 * §3〜§6、§7 の第2段）。第1段（candidates.ts）が露出させた候補列を
 * 入力に、セグメント系列全体を Viterbi で再評価する純粋な後段
 * モジュール。認識エンジン本体には触れず、オプション
 * （theoryReevaluation、既定 OFF）のときだけ両経路の最終段から
 * 呼ばれる。OFF のときはもちろん、ON でも候補が無いセグメント列
 * には無動作で従来と完全一致する。
 *
 * 使う評価軸は設計書 §1 の 5 軸のうち 3 系統のみ:
 * (1) キー整合性 — 入力は既存の局所キー記録（§6.6。無ければ
 *     全体キーへフォールバック）。候補の構成音が局所キーの
 *     スケールにどれだけ収まるか（scale fit）を、窓の次点キーとの
 *     重み付き平均で見る。
 * (2) ダイアトニック整合性 — 全体キーに対する scale fit を、
 *     §6.3 の「説明可能性」で浅くする: 二次ドミナント・平行調
 *     からの借用・ナポリ和音として標準的な機能説明がつく
 *     非ダイアトニック候補は、減点の床（fit 2/3 相当）で止める。
 *     説明のつかないものだけが fit の生値を受ける。
 * (4)(5) 機能的遷移 — 前後関係は系列最適化のエッジとして評価する
 *     （V→I、二次ドミナントの解決連鎖、プラガル、五度圏運動等。
 *     規則表は transitionFeature のコメント参照）。§6.7 のとおり
 *     遷移の情報はフレーム証拠とほぼ独立であり、二重数えに
 *     なりにくいため、重み配分でも最大の取り分を与える。
 * 含めないもの: (3) 進行統計（様式パック＝第3段）、拡張段の候補
 * （maj9/maj13 の命名を含む。別作業）、ボイシング／楽器特徴
 * （前提部品なし）。候補は三和音レベルのまま。
 *
 * スコア合成と上限（§5）:
 * - 合成は対数線形: 状態スコア = emission ＋ Σ 重み×理論特徴。
 * - emission は候補スコアそのものではなく、第1段の符号つき
 *   マージンを主信号にする（第1段の引き継ぎ: 候補スコアは較正
 *   済み確率ではなくコサイン類似度であり、確定ルートはフレーム列
 *   ＋ベース証拠の複合判定で、単一集計の argmax とは実曲で
 *   4〜5 割しか一致しない）。変換は順序保存の逓減型:
 *   接戦域 |margin| ≤ E（E = emissionClamp）ではマージンを額面
 *   どおり数え、その外側は 1/4 の重みで数える（EMISSION_TAIL）。
 *   代替同士の順序（集計がどの代替を最も支持するか）は潰さず、
 *   ただし集計は1つの視点にすぎないため、その強い言い分は
 *   逓減させて数える。正マージン側は後段ガード（下記）が
 *   swingCap 以上を機械的に守るため、この逓減と合わせて
 *   「勝者が集計でも明確に優位な候補は覆らない」が保たれる。
 *   負マージン側に上限を設けないのは、その場合は集計自身が
 *   音響側の反対証拠であり、理論は代替同士の仲裁と勝者の
 *   擁護（上限の内側）だけを担う、という役割分担による。
 * - 理論側の寄与総量に上限を置く: 各特徴の値域と重みから、
 *   1 セグメントあたりの理論優位（候補 − 勝者、両隣のエッジを
 *   含む）の最大値 swingCap が構成で決まる
 *   （w_key + w_dia + 4·w_tr = swingCap）。さらに後段ガードで、
 *   生マージンが swingCap 以上の候補への反転は経路の都合でも
 *   起きないことを保証する。音響が明確な候補は理論で覆らない。
 *
 * 較正の根拠（重みと上限は評価スイートの正解では決めていない）:
 * 第1段候補のマージン分布を真値なしで測ったプローブ
 * （2026-10-29、measurements/theory/THEORY_ENGINE_STEP2.md §2）:
 * 実曲では rank-2 マージンの中央値が負（−0.02〜−0.07。集計が
 * 勝者と割れているのが常態）、p75 でも +0.02〜+0.06 にとどまる
 * 一方、合成曲では中央値 +0.126 と大きい。swingCap = 0.06 は
 * 「実曲で集計が曖昧な範囲の上限側、合成では典型的な決着
 * マージンの半分以下」に置いた値であり、配分は遷移 1/2、
 * キー整合性 1/4、ダイアトニック 1/4（§6.7 の有望度順）。
 *
 * N.C. の扱い（§6.5）: N.C. セグメントは N.C. 状態のみを持ち、
 * 理論でラベルを発明しない。ラベルありセグメントにも N.C.
 * 状態は置かない（理論でラベルを消さない）。N.C. に触れる
 * エッジは中立（0）。したがって N.C. の時間は構成上不変。
 *
 * 反転の保護: 拡張音（extension）・層表示（upperChord）・
 * 付加音（addTones）・N.C. 充填（ncFill）が付いたセグメントは
 * 反転させない。それらの装飾は旧コアに対して判定されたもので、
 * コアだけを差し替えると不整合になるため（装飾の再判定は
 * 本モジュールの範囲外）。
 *
 * 反転したセグメントには根拠内訳（TheoryRationale）を加算的に
 * 残す（§3 の契約）。candidates・bassPc・信頼度・境界は変えない。
 *
 * ------------------------------------------------------------------
 * 再挑戦（v2、THEORY_WEIGHTS_V2）: 初回主構成（v1）は事前登録
 * 基準を満たさず不採用となった（STEP2.md §4）。v2 は §5 の
 * 再設計の出発点を、重み・上限・遷移表は v1 と同一に保ったまま
 * 意味論だけ3点作り替えた構成であり、オプション
 * theoryReevaluationV2（既定 OFF）で接続する。v1 の挙動は
 * THEORY_WEIGHTS のまま不変で、履歴として再現可能に保つ。
 *
 * 柱1 floored の前提化: emission は負マージンの候補に 0 を返す。
 *   集計の反対は「現ラベルへの支持が弱い」表明に留め、代替への
 *   正の証拠にしない。正マージン側は v1 と同一（勝者の集計上の
 *   優位は反転への抵抗として数える非対称は意図的。根拠は
 *   THEORY_ENGINE_STEP2_RETRY.md §1）。
 * 柱2 キー項の信頼度ゲート: 局所キー窓の margin ≥ 0.08 かつ
 *   correlation ≥ 0.74（全スイート窓 578 件の pooled 中央値の
 *   丸め、真値なしプローブ）を満たさない窓では軸1は沈黙する。
 *   局所キー記録が無い場合（全体キーの文脈）はゲートしない。
 * 柱3 現ラベル擁護: 遷移は Viterbi の経路評価として勝者・
 *   挑戦者の双方に常に対等に効く（v1 でも構造上そうであった）
 *   ことに加え、現ラベル（候補1位）のノードにホーム
 *   アドバンテージ H = 0.005 を加算する。H は理論特徴の
 *   分解能の最小量子（キー適合 1/3 段 × w_key）に等しく、
 *   それ以下の理論優位はノイズとして現ラベルを守る。反転は
 *   挑戦者の優位が H を上回る場合にだけ起こる。H は根拠内訳
 *   には項目として載らない（定数の現状維持項であり、内訳は
 *   各軸の寄与差を示す契約のため）。較正の経緯（初版の
 *   H = swingCap/2 を測定前に訂正した理由を含む）は
 *   THEORY_ENGINE_STEP2_RETRY.md §1 に記録した。
 *
 * ------------------------------------------------------------------
 * 内部関数の export について: emission / resolveKeyContext /
 * keyFeature / diatonicFeature / isProtected は、音符仲裁主軸の
 * 再評価器（noteArbitration.ts）が「v2 の理論構成を凍結したまま
 * 補助として使う」ために export している（pairwise の形で再利用
 * する。THEORY_ENGINE_NOTE_ARBITRATION.md 参照）。export の追加は
 * v1/v2 の挙動を変えない（測定ハーネスで初回保存値との一致を
 * 引き続き確認する）。
 */

export interface TheoryWeights {
  /** キー整合性（特徴は [0,1]）の重み */
  key: number;
  /** ダイアトニック整合性（特徴は [0,1]）の重み */
  diatonic: number;
  /** 機能的遷移（特徴は [−1,1]、エッジごと）の重み */
  transition: number;
  /** emission の接戦域の幅 E（この内側ではマージンを額面で数える） */
  emissionClamp: number;
  /**
   * emission の逓減率: 接戦域の外側でマージンを数える割合。
   * 主構成は EMISSION_TAIL（0.25）。測定の感度変種でのみ変える
   * （0 = 完全なクランプ型 emission）。
   */
  emissionTail: number;
  /**
   * true の場合、負マージン（集計だけなら代替優位）を emission 0
   * に切り捨てる。初回は測定の探索変種専用だったが、再挑戦（v2）
   * では前提化した（柱1）。正マージン側は通常の逓減変換で数える
   * ため、逓減率 0 の場合は初回の探索変種 floored と一致する。
   */
  emissionFloorAtZero: boolean;
  /**
   * 再挑戦（v2）の柱2: キー項の信頼度ゲート。局所キー窓の
   * margin（最有力−次点の相関差）と correlation（最有力キーの
   * 相関）が両方とも閾値以上でない窓では、キー項は沈黙する。
   * 未指定（v1）はゲートなし。局所キー記録が無い場合（全体キー
   * 文脈）はゲートを適用しない。
   */
  keyGate?: { margin: number; correlation: number };
  /**
   * 再挑戦（v2）の柱3: 現ラベル擁護のホームアドバンテージ。
   * 候補1位（現ラベル）のノードスコアへの加算（スコア単位は
   * マージンと同じ）。未指定（v1）は 0。
   */
  homeAdvantage?: number;
  /**
   * 理論優位の上限（ガード用）。重みから構成される値と一致させる
   * こと（key + diatonic + 4·transition）。生マージンがこれ以上の
   * 候補は反転しない。
   */
  swingCap: number;
}

/** 主構成の重み（較正の根拠は冒頭コメントと STEP2.md §2） */
export const THEORY_WEIGHTS: TheoryWeights = {
  key: 0.015,
  diatonic: 0.015,
  transition: 0.0075,
  emissionClamp: 0.06,
  swingCap: 0.06,
  emissionTail: 0.25,
  emissionFloorAtZero: false,
};

/**
 * 再挑戦（v2）の主構成。軸の重み・上限・接戦域は v1 と同一に
 * 保ち、意味論の3点だけを変えた構成（冒頭コメントの「再挑戦」
 * 節と THEORY_ENGINE_STEP2_RETRY.md §1〜§2 が較正の根拠）。
 */
export const THEORY_WEIGHTS_V2: TheoryWeights = {
  key: 0.015,
  diatonic: 0.015,
  transition: 0.0075,
  emissionClamp: 0.06,
  swingCap: 0.06,
  emissionTail: 0.25,
  emissionFloorAtZero: true,
  keyGate: { margin: 0.08, correlation: 0.74 },
  homeAdvantage: 0.005,
};

/** 評価器への曲プロファイル入力（共有プロファイルの部分集合） */
export interface TheoryProfile {
  /** 見出しキー（結果の keyRoot / keyMode） */
  keyRoot: number;
  keyMode: "major" | "minor";
  /** 局所キー記録（localKeyRecord の窓列）。無ければ全体キーを使う */
  localKeys?: LocalKeyWindow[];
}

type Mode = "major" | "minor";

const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11];
const MINOR_SCALE = [0, 2, 3, 5, 7, 8, 10]; // 自然短音階

const rel = (pc: number, origin: number) => ((pc - origin) % 12 + 12) % 12;

function scalePcs(keyRoot: number, keyMode: Mode): Set<number> {
  const scale = keyMode === "major" ? MAJOR_SCALE : MINOR_SCALE;
  return new Set(scale.map((d) => (keyRoot + d) % 12));
}

/**
 * 候補の構成音がキーのスケールに収まる割合（0, 1/3, 2/3, 1）。
 * 短調の属和音（V）は和声短音階の導音を含むため、自然短音階の
 * 引き算では 2/3 になるが、機能的には最もダイアトニックな
 * 和音の1つなので例外として 1 とする（標準的な扱い）。
 */
export function keyScaleFit(
  root: number,
  mode: Mode,
  keyRoot: number,
  keyMode: Mode,
): number {
  if (keyMode === "minor" && mode === "major" && rel(root, keyRoot) === 7) {
    return 1;
  }
  const scale = scalePcs(keyRoot, keyMode);
  const third = mode === "major" ? 4 : 3;
  const pcs = [root, (root + third) % 12, (root + 7) % 12];
  return pcs.filter((p) => scale.has(p)).length / 3;
}

/** キーのダイアトニック三和音（(相対度数, モード) の列。減和音は候補空間に無いため除く） */
function diatonicTriads(keyMode: Mode): { deg: number; mode: Mode }[] {
  return keyMode === "major"
    ? [
        { deg: 0, mode: "major" },
        { deg: 2, mode: "minor" },
        { deg: 4, mode: "minor" },
        { deg: 5, mode: "major" },
        { deg: 7, mode: "major" },
        { deg: 9, mode: "minor" },
      ]
    : [
        { deg: 0, mode: "minor" },
        { deg: 3, mode: "major" },
        { deg: 5, mode: "minor" },
        { deg: 7, mode: "major" }, // V（和声短音階）
        { deg: 8, mode: "major" },
        { deg: 10, mode: "major" },
      ];
}

function isDiatonicTriad(
  root: number,
  mode: Mode,
  keyRoot: number,
  keyMode: Mode,
): boolean {
  const deg = rel(root, keyRoot);
  return diatonicTriads(keyMode).some((t) => t.deg === deg && t.mode === mode);
}

/**
 * 非ダイアトニック候補に標準的な機能説明がつくか（§6.3）。
 * - 二次ドミナント: ダイアトニック和音のいずれかへ五度上から
 *   解決する長三和音（V/x の三和音コア）
 * - 平行調からの借用: 平行長調／短調のダイアトニック三和音
 *   （短調でのピカルディ三度＝平行長調の I もここに含まれる）
 * - ナポリ和音: ♭II の長三和音
 */
export function isExplainable(
  root: number,
  mode: Mode,
  keyRoot: number,
  keyMode: Mode,
): boolean {
  if (mode === "major") {
    const scale = keyMode === "major" ? MAJOR_SCALE : MINOR_SCALE;
    for (const d of scale) {
      if (root === (keyRoot + d + 7) % 12) return true; // 二次ドミナント
    }
  }
  const parallel: Mode = keyMode === "major" ? "minor" : "major";
  if (isDiatonicTriad(root, mode, keyRoot, parallel)) return true; // 借用
  if (mode === "major" && rel(root, keyRoot) === 1) return true; // ナポリ
  return false;
}

/** ダイアトニック特徴（軸2）: 全体キーへの fit、説明可能なら床 2/3 */
export function diatonicFeature(
  root: number,
  mode: Mode,
  profile: TheoryProfile,
): number {
  const fit = keyScaleFit(root, mode, profile.keyRoot, profile.keyMode);
  if (fit >= 1) return 1;
  if (isExplainable(root, mode, profile.keyRoot, profile.keyMode)) {
    return Math.max(fit, 2 / 3);
  }
  return fit;
}

// ---------------------------------------------------------------------------
// 局所キー文脈
// ---------------------------------------------------------------------------

export interface KeyContext {
  root: number;
  mode: Mode;
  /** 次点キーの重み（0 = 次点なし）。窓の margin から決める */
  runnerUp?: { root: number; mode: Mode; weight: number };
  /**
   * 柱2（v2）: この文脈ではキー項が沈黙するか。ゲート設定があり、
   * セグメントの属する局所キー窓が信頼度閾値を満たさない場合に
   * true。全体キー文脈（窓なし）では常に false。
   */
  keySilent: boolean;
}

export function resolveKeyContext(
  seg: ChordSegment,
  profile: TheoryProfile,
  gate?: { margin: number; correlation: number },
): KeyContext {
  const windows = profile.localKeys;
  if (windows && windows.length > 0) {
    const mid = (seg.start + seg.end) / 2;
    let win = windows.find((w) => mid >= w.start && mid < w.end);
    if (!win) {
      let best = Infinity;
      for (const w of windows) {
        const d = mid < w.start ? w.start - mid : mid - w.end;
        if (d < best) {
          best = d;
          win = w;
        }
      }
    }
    if (win) {
      // 次点は「相関差が小さい窓でだけ」半分までの重みで数える
      const weight = 0.5 * Math.min(1, Math.max(0, 1 - win.margin / 0.15));
      return {
        root: win.root,
        mode: win.mode,
        ...(weight > 0
          ? {
              runnerUp: {
                root: win.runnerUpRoot,
                mode: win.runnerUpMode,
                weight,
              },
            }
          : {}),
        keySilent:
          gate !== undefined &&
          !(win.margin >= gate.margin && win.correlation >= gate.correlation),
      };
    }
  }
  return { root: profile.keyRoot, mode: profile.keyMode, keySilent: false };
}

/** キー整合性特徴（軸1）: 局所キー文脈への fit（次点との加重平均） */
export function keyFeature(root: number, mode: Mode, ctx: KeyContext): number {
  const fit = keyScaleFit(root, mode, ctx.root, ctx.mode);
  if (!ctx.runnerUp) return fit;
  const rFit = keyScaleFit(root, mode, ctx.runnerUp.root, ctx.runnerUp.mode);
  return (fit + ctx.runnerUp.weight * rFit) / (1 + ctx.runnerUp.weight);
}

// ---------------------------------------------------------------------------
// 機能的遷移（軸4・5）
// ---------------------------------------------------------------------------

/**
 * 前コード a から後コード b への機能的遷移の評価 [−1, 1]。
 * 文脈キーは b 側セグメントの局所キー（解決先のキーで読む）。
 * 規則は標準的な機能和声の定型であり、評価スイートで調整した
 * ものではない。適用順（最初に当たった規則が勝つ）:
 *
 *  1. 同一コードの継続 +0.4／同ルートのモード変化 +0.15
 *  2. 主和音への解決: V→I +1.0（authentic）、IV→I +0.6（plagal）
 *  3. 二次ドミナントの解決連鎖（V/x → x、x はダイアトニック）+0.9
 *     — §6.7 の B7→E7（A minor での V/V→V）がこの形
 *  4. 偽終止 V→VI +0.3
 *  5. 属和音への進行（ダイアトニック → V）+0.35（半終止の型）
 *  6. 逆行の罰: V→IV −0.5、V→ii −0.35
 *  7. 両方ダイアトニック: 五度下行運動 +0.6、五度上行 +0.2、
 *     二度運動 +0.15、三度運動 +0.1
 *  8. どちらかが非ダイアトニック（説明の有無によらない）:
 *     ルート運動だけの弱い評価（下行五度 +0.4、上行五度 +0.15、
 *     二度 +0.05）。非ダイアトニックであること自体の罰は軸2の
 *     担当であり、ここで二重に罰しない（§6.3）
 */
export function transitionFeature(
  a: { root: number; mode: Mode },
  b: { root: number; mode: Mode },
  keyRoot: number,
  keyMode: Mode,
): number {
  if (a.root === b.root) return a.mode === b.mode ? 0.4 : 0.15;

  const isTonic = (c: { root: number; mode: Mode }) =>
    c.root === keyRoot && c.mode === keyMode;
  const isDominant = (c: { root: number; mode: Mode }) =>
    rel(c.root, keyRoot) === 7 && c.mode === "major";

  if (isTonic(b)) {
    if (isDominant(a)) return 1.0;
    if (rel(a.root, keyRoot) === 5 && isDiatonicTriad(a.root, a.mode, keyRoot, keyMode)) {
      return 0.6;
    }
  }
  if (
    a.mode === "major" &&
    !isDominant(a) &&
    isDiatonicTriad(b.root, b.mode, keyRoot, keyMode) &&
    a.root === (b.root + 7) % 12
  ) {
    return 0.9; // 二次ドミナントの解決
  }
  if (isDominant(a)) {
    const submediant = keyMode === "major" ? 9 : 8;
    if (rel(b.root, keyRoot) === submediant) return 0.3; // 偽終止
    if (rel(b.root, keyRoot) === 5) return -0.5; // V→IV 逆行
    if (rel(b.root, keyRoot) === 2) return -0.35; // V→ii 逆行
  }
  if (isDominant(b) && isDiatonicTriad(a.root, a.mode, keyRoot, keyMode)) {
    return 0.35; // 属和音への進行
  }

  const motion = rel(b.root, a.root); // a から b へのルート運動（半音）
  const bothDiatonic =
    isDiatonicTriad(a.root, a.mode, keyRoot, keyMode) &&
    isDiatonicTriad(b.root, b.mode, keyRoot, keyMode);
  if (bothDiatonic) {
    if (motion === 5) return 0.6; // 五度下行（五度圏の解決方向）
    if (motion === 7) return 0.2; // 五度上行
    if (motion === 1 || motion === 2 || motion === 10 || motion === 11) {
      return 0.15; // 二度運動
    }
    if (motion === 3 || motion === 4 || motion === 8 || motion === 9) {
      return 0.1; // 三度運動
    }
    return 0;
  }
  if (motion === 5) return 0.4;
  if (motion === 7) return 0.15;
  if (motion === 1 || motion === 2 || motion === 10 || motion === 11) {
    return 0.05;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// 系列最適化（Viterbi）
// ---------------------------------------------------------------------------

interface State {
  /** 候補インデックス。N.C. 状態は -1 */
  candIndex: number;
  root: number;
  mode: Mode;
  /** 第1段の符号つきマージン（N.C. 状態は 0） */
  margin: number;
  /** ノードスコア（emission ＋ キー ＋ ダイアトニック） */
  node: number;
}

/** emission の逓減率の主構成値: 接戦域の外側でマージンを数える割合 */
export const EMISSION_TAIL = 0.25;

export function emission(margin: number, weights: TheoryWeights): number {
  const e = weights.emissionClamp;
  if (margin < 0 && weights.emissionFloorAtZero) {
    // 柱1（v2 では前提、初回は探索変種）: 集計の反対（負マージン）
    // は代替への正の証拠にしない。emission は 0（＝現ラベルと同値）
    // であり、代替が勝てるのは理論項が柱3の擁護を上回る場合だけ。
    // 逓減率 0 の設定では初回の探索変種 floored と完全に一致する。
    return 0;
  }
  const a = Math.abs(margin);
  const g =
    a <= e ? margin : Math.sign(margin) * (e + (a - e) * weights.emissionTail);
  return -g;
}

/** 装飾つきセグメントは反転保護（冒頭コメント参照） */
export function isProtected(seg: ChordSegment): boolean {
  return Boolean(
    seg.extension || seg.upperChord || (seg.addTones && seg.addTones.length > 0) || seg.ncFill,
  );
}

function buildStates(
  seg: ChordSegment,
  ctx: KeyContext,
  profile: TheoryProfile,
  weights: TheoryWeights,
): State[] {
  if (seg.chord === NO_CHORD || !seg.candidates || seg.candidates.length === 0) {
    // N.C.（または候補なし）は N.C. 状態のみ。ラベルを発明しない
    return [{ candIndex: -1, root: -1, mode: "major", margin: 0, node: 0 }];
  }
  const usable = isProtected(seg) ? seg.candidates.slice(0, 1) : seg.candidates;
  return usable.map((c, i) => ({
    candIndex: i,
    root: c.root,
    mode: c.mode,
    margin: c.margin,
    node:
      emission(c.margin, weights) +
      // 柱2: ゲートで沈黙する窓ではキー項は全候補に 0（差が付かない）
      (ctx.keySilent ? 0 : weights.key * keyFeature(c.root, c.mode, ctx)) +
      weights.diatonic * diatonicFeature(c.root, c.mode, profile) +
      // 柱3: 現ラベル（候補1位）へのホームアドバンテージ
      (i === 0 ? (weights.homeAdvantage ?? 0) : 0),
  }));
}

/**
 * 候補列を持つセグメント列を系列再評価した新しい配列を返す
 * （入力は変更しない）。候補が付いていないセグメントはそのまま
 * 通る。反転したセグメントには theoryRationale が付く。
 */
export function applyTheoryReevaluation(
  segments: ChordSegment[],
  profile: TheoryProfile,
  weights: TheoryWeights = THEORY_WEIGHTS,
): ChordSegment[] {
  if (segments.length === 0) return segments;
  const contexts = segments.map((seg) =>
    resolveKeyContext(seg, profile, weights.keyGate),
  );
  const states = segments.map((seg, i) =>
    buildStates(seg, contexts[i], profile, weights),
  );

  // Viterbi 前向き計算。同点では若い状態インデックス（勝者が先頭）
  // を残すため、更新は厳密な改善（>）のときだけ行う
  // ＝「理論の実現優位が正でない限り反転しない」バイアス。
  const back: number[][] = states.map(() => []);
  let prevScores = states[0].map((s) => s.node);
  for (let i = 1; i < segments.length; i++) {
    const ctx = contexts[i];
    const scores = new Array(states[i].length).fill(-Infinity);
    back[i] = new Array(states[i].length).fill(0);
    for (let s = 0; s < states[i].length; s++) {
      const cur = states[i][s];
      for (let p = 0; p < states[i - 1].length; p++) {
        const prev = states[i - 1][p];
        const edge =
          prev.candIndex < 0 || cur.candIndex < 0
            ? 0
            : weights.transition *
              transitionFeature(prev, cur, ctx.root, ctx.mode);
        const total = prevScores[p] + edge + cur.node;
        if (total > scores[s]) {
          scores[s] = total;
          back[i][s] = p;
        }
      }
    }
    prevScores = scores;
  }
  let last = 0;
  for (let s = 1; s < prevScores.length; s++) {
    if (prevScores[s] > prevScores[last]) last = s;
  }
  const chosen = new Array<number>(segments.length).fill(0);
  chosen[segments.length - 1] = last;
  for (let i = segments.length - 1; i > 0; i--) {
    chosen[i - 1] = back[i][chosen[i]];
  }

  // 後段ガード: 生マージンが swingCap 以上の候補への反転は、
  // 経路全体の都合でも起こさない（上限の保証。冒頭コメント参照）
  for (let i = 0; i < segments.length; i++) {
    const st = states[i][chosen[i]];
    if (st.candIndex > 0 && st.margin >= weights.swingCap) {
      chosen[i] = 0;
    }
  }

  return segments.map((seg, i) => {
    const st = states[i][chosen[i]];
    if (st.candIndex <= 0) return seg; // 勝者または N.C. のまま
    const winner = states[i][0];
    const ctx = contexts[i];
    const prevState = i > 0 ? states[i - 1][chosen[i - 1]] : null;
    const nextState = i < segments.length - 1 ? states[i + 1][chosen[i + 1]] : null;
    const nextCtx = i < segments.length - 1 ? contexts[i + 1] : null;
    const rationale: TheoryRationale = {
      fromRoot: winner.root,
      fromMode: winner.mode,
      acousticMargin: st.margin,
      key: ctx.keySilent
        ? 0
        : weights.key * (keyFeature(st.root, st.mode, ctx) - keyFeature(winner.root, winner.mode, ctx)),
      diatonic:
        weights.diatonic *
        (diatonicFeature(st.root, st.mode, profile) -
          diatonicFeature(winner.root, winner.mode, profile)),
      transitionPrev:
        prevState && prevState.candIndex >= 0
          ? weights.transition *
            (transitionFeature(prevState, st, ctx.root, ctx.mode) -
              transitionFeature(prevState, winner, ctx.root, ctx.mode))
          : 0,
      transitionNext:
        nextState && nextState.candIndex >= 0 && nextCtx
          ? weights.transition *
            (transitionFeature(st, nextState, nextCtx.root, nextCtx.mode) -
              transitionFeature(winner, nextState, nextCtx.root, nextCtx.mode))
          : 0,
    };
    return { ...seg, chord: chordName(st.root, st.mode), theoryRationale: rationale };
  });
}

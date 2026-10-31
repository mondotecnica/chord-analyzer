import type { ChordSegment } from "../types";

/**
 * 小節グリッド（小節番号表示）の純関数モジュール。
 *
 * ユーザーが確認・調整できるグリッド設定 { bpm, beatsPerBar,
 * offsetSec } から、時刻と小節番号の対応を計算する表示専用の層で
 * あり、解析パイプラインには一切接続しない（キートランスポーズ
 * lib/transpose.ts、度数 lib/degrees.ts と同じ「表示・書き出し用に
 * 導出するだけ」の位置づけ）。グリッドをいくら変えても解析結果
 * オブジェクトは変更されない。
 *
 * ## なぜユーザー設定なのか
 * 拍子の自動推定は過去に実曲で 2/4 誤判定があり不採用になった
 * （measurements/phase3/PHASE3_METER_RESULTS.md）。そのため拍子は
 * 推定せず、ユーザーが設定する。BPM は解析の推定値を初期値として
 * 渡せるが、それも含めて全てユーザーが編集できる前提で設計する:
 * - bpm: 1拍の長さ（60 / bpm 秒）。解析値が初期値、編集可
 * - beatsPerBar: 1小節の拍数（整数）。既定 4
 * - offsetSec: 1小節目1拍目が始まる時刻（秒）。既定 0
 *
 * ## 端の仕様（v1 の割り切り）
 * - 小節番号は 1 始まり。offsetSec より前の時刻は小節 0 にはせず
 *   「1小節目の途中」として小節 1 に数える（冒頭のピックアップや
 *   無音部分をマイナスの小節で表さないための割り切り）。
 * - barStartSec(1) は offsetSec そのもの。offsetSec > 0 の場合、
 *   1小節目は [0, offsetSec + 1小節) ではなく [0, offsetSec) の
 *   部分も含めて小節 1 として表示される（上記の割り切りの帰結）。
 * - 複合拍子（6/8 等）の専用セマンティクスは持たない。グリッドは
 *   「bpm の拍 × beatsPerBar 本 = 1小節」という等間隔の物差しで
 *   しかないため、6/8 は「1拍 = 8分音符、拍数 6」としてでも
 *   「1拍 = 付点4分音符、拍数 2」としてでも表現できる。どちらで
 *   数えるかはユーザーの設定に委ねる。
 * - 浮動小数の境界誤差対策として、時刻→小節の換算には微小な
 *   epsilon を加える（小節境界ちょうどに始まるセグメントが
 *   1つ前の小節に落ちないように）。
 *
 * ## 拍子変更の区間宣言
 * 途中で拍子が変わる曲のために、基準グリッドへ区間のリスト
 * （BarGridSection）を重ねられる。各区間は「startBar 小節目から
 * beatsPerBar 拍子に変わる」という宣言で、任意で bpm も変えら
 * れる（省略した区間は基準グリッドの bpm を引き継ぐ）。小節
 * 番号は区間をまたいでも連続し、各区間の開始時刻は手前の区間
 * の小節長で累積して決まる。区間宣言が無い場合は従来の単一
 * グリッドと完全に同じ挙動になる（後方互換）。
 * - startBar は「宣言が効き始める小節番号」であり、手前までの
 *   グリッドで数えた番号そのもの。1 は基準グリッドの担当範囲
 *   なので区間では指定できない（2 以上。正規化で落とす）。
 * - 同じ startBar の宣言が複数ある場合は、後に書かれた方を採る。
 * - 区間の bpm は「その区間のテンポ」であって、基準グリッドの
 *   bpm を後から変えても追随しない（明示した値が残る）。
 */

/**
 * 拍子変更の区間宣言（「startBar 小節目からこの拍子」）。
 * 基準グリッド（BarGridSettings 本体）の上に重ねる。
 */
export interface BarGridSection {
  /** この宣言が効き始める小節番号（2 以上） */
  startBar: number;
  /** この区間の1小節の拍数（整数、1 以上） */
  beatsPerBar: number;
  /** この区間のテンポ。省略時は基準グリッドの bpm を引き継ぐ */
  bpm?: number;
}

/** 小節グリッド設定（ユーザー調整可能、表示・書き出し専用） */
export interface BarGridSettings {
  /** テンポ（1分あたりの拍数）。1拍 = 60 / bpm 秒 */
  bpm: number;
  /** 1小節の拍数（整数、1 以上） */
  beatsPerBar: number;
  /** 1小節目1拍目が始まる時刻（秒、0 以上） */
  offsetSec: number;
  /** 拍子変更の区間宣言。無い（または空の）場合は単一グリッド */
  sections?: ReadonlyArray<BarGridSection>;
}

/** BPM が得られない・不正な場合のフォールバック（表示専用の仮置き） */
export const FALLBACK_BPM = 120;

/** 拍子（beatsPerBar）の既定値。拍子は推定しないため固定の初期値 */
export const DEFAULT_BEATS_PER_BAR = 4;

const EPSILON = 1e-6;

/**
 * グリッド設定を妥当な値に整える。不正な値（NaN、無限、bpm <= 0 等）
 * はフォールバックに置き換え、beatsPerBar は 1..12 の整数に、
 * offsetSec は 0 以上に丸める。有効な bpm の範囲には上限を設けない
 * （ユーザーの入力を勝手に書き換えないため）。区間宣言は
 * normalizeBarGridSections で整え、有効な区間が無い場合は
 * sections キー自体を付けない。
 */
/** 拍数を 1..12 の整数に丸める（不正値は既定値） */
function normalizeBeatsPerBar(value: number): number {
  return Number.isFinite(value)
    ? Math.min(12, Math.max(1, Math.round(value)))
    : DEFAULT_BEATS_PER_BAR;
}

/** bpm として有効ならその値、そうでなければ null */
function validBpm(value: number | undefined): number | null {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? value
    : null;
}

/**
 * 区間宣言リストを正規化する。startBar が 2 未満・不正な宣言は
 * 落とし、同じ startBar は後に書かれた方を採り、startBar 昇順に
 * 並べる。bpm の無い（または不正な）区間は bpm を持たない形に
 * する（= 基準グリッドの bpm を引き継ぐ）。
 */
export function normalizeBarGridSections(
  sections: ReadonlyArray<BarGridSection> | undefined,
): BarGridSection[] {
  if (!sections) return [];
  const byStartBar = new Map<number, BarGridSection>();
  for (const s of sections) {
    if (!s || !Number.isFinite(s.startBar)) continue;
    const startBar = Math.floor(s.startBar);
    if (startBar < 2) continue;
    const bpm = validBpm(s.bpm);
    byStartBar.set(startBar, {
      startBar,
      beatsPerBar: normalizeBeatsPerBar(s.beatsPerBar),
      ...(bpm !== null ? { bpm } : {}),
    });
  }
  return [...byStartBar.values()].sort((a, b) => a.startBar - b.startBar);
}

export function normalizeBarGrid(grid: BarGridSettings): BarGridSettings {
  const bpm =
    Number.isFinite(grid.bpm) && grid.bpm > 0 ? grid.bpm : FALLBACK_BPM;
  const beatsPerBar = normalizeBeatsPerBar(grid.beatsPerBar);
  const offsetSec =
    Number.isFinite(grid.offsetSec) && grid.offsetSec > 0
      ? grid.offsetSec
      : 0;
  const sections = normalizeBarGridSections(grid.sections);
  // 区間が無い場合は sections キー自体を持たせない（従来の形と一致させ、
  // 書き出しや toEqual 比較で余分な差分を出さないため）
  return sections.length > 0
    ? { bpm, beatsPerBar, offsetSec, sections }
    : { bpm, beatsPerBar, offsetSec };
}

/**
 * 既定のグリッド設定。bpm は解析の推定値（無ければフォールバック）、
 * 拍子は 4、オフセットは 0。
 */
export function defaultBarGrid(bpm: number | null): BarGridSettings {
  return {
    bpm: bpm !== null && Number.isFinite(bpm) && bpm > 0 ? bpm : FALLBACK_BPM,
    beatsPerBar: DEFAULT_BEATS_PER_BAR,
    offsetSec: 0,
  };
}

/** 1拍の長さ（秒） */
export function beatDurationSec(grid: BarGridSettings): number {
  return 60 / normalizeBarGrid(grid).bpm;
}

/** 1小節の長さ（秒） */
export function barDurationSec(grid: BarGridSettings): number {
  const g = normalizeBarGrid(grid);
  return (60 / g.bpm) * g.beatsPerBar;
}

/** 区間を解決したスパン（連続した小節範囲と、その物差し） */
interface GridSpan {
  /** このスパンが始まる小節番号 */
  startBar: number;
  /** このスパンが始まる時刻（秒）。先頭スパンは offsetSec */
  startSec: number;
  /** このスパンの1小節の長さ（秒） */
  barSec: number;
}

/**
 * グリッドをスパン列に解決する。先頭スパンは基準グリッド
 * （小節 1 から最初の区間宣言の直前まで）、以降は各区間宣言が
 * 1スパンずつになる。各スパンの開始時刻は、手前までの小節長を
 * 累積して決まる。区間が無ければスパンは1つだけになり、従来の
 * 単一グリッドの計算と一致する。
 */
function resolveSpans(grid: BarGridSettings): GridSpan[] {
  const g = normalizeBarGrid(grid);
  const spans: GridSpan[] = [];
  let startBar = 1;
  let startSec = g.offsetSec;
  let bpm = g.bpm;
  let beatsPerBar = g.beatsPerBar;
  for (const section of g.sections ?? []) {
    const barSec = (60 / bpm) * beatsPerBar;
    spans.push({ startBar, startSec, barSec });
    startSec += (section.startBar - startBar) * barSec;
    startBar = section.startBar;
    bpm = section.bpm ?? g.bpm;
    beatsPerBar = section.beatsPerBar;
  }
  spans.push({ startBar, startSec, barSec: (60 / bpm) * beatsPerBar });
  return spans;
}

/**
 * 時刻（秒）→ 小節番号（1 始まり）。
 * offsetSec より前は「1小節目の途中」として 1 を返す。
 * 区間宣言がある場合は、その時刻を含むスパンの中で数える。
 */
export function barNumberAt(timeSec: number, grid: BarGridSettings): number {
  const g = normalizeBarGrid(grid);
  if (!Number.isFinite(timeSec)) return 1;
  if (timeSec - g.offsetSec < 0) return 1;
  const spans = resolveSpans(g);
  // 時刻を含むスパン（開始時刻がその時刻以下の最後のスパン）を探す。
  // スパン境界ちょうどの時刻はどちらのスパンで数えても同じ小節に
  // なる（境界 = 次スパンの startBar ちょうど）ため、単純な比較で良い
  let span = spans[0];
  for (const s of spans) {
    if (s.startSec <= timeSec) span = s;
    else break;
  }
  return (
    span.startBar +
    Math.floor((timeSec - span.startSec) / span.barSec + EPSILON)
  );
}

/**
 * 小節番号（1 始まり）→ その小節が始まる時刻（秒）。
 * 1 未満の小節番号は 1 として扱う。
 * 区間宣言がある場合は、その小節を含むスパンから累積で求める。
 */
export function barStartSec(barNumber: number, grid: BarGridSettings): number {
  const g = normalizeBarGrid(grid);
  const n = Number.isFinite(barNumber) ? Math.max(1, Math.floor(barNumber)) : 1;
  const spans = resolveSpans(g);
  let span = spans[0];
  for (const s of spans) {
    if (s.startBar <= n) span = s;
    else break;
  }
  return span.startSec + (n - span.startBar) * span.barSec;
}

/** セグメントの開始小節番号（セグメントの開始時刻で数える） */
export function segmentStartBar(
  seg: Pick<ChordSegment, "start">,
  grid: BarGridSettings,
): number {
  return barNumberAt(seg.start, grid);
}

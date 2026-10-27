/**
 * 高精度モード（ステム分離）の「実行中マーカー」（sessionStorage）。
 *
 * 背景: iOS Safari はメモリ圧迫時にページごと再読み込みすることがある。
 * その場合、アプリ内のどのエラーハンドラも走らず、全状態（選択した
 * ファイル、モード、通知）が初期化されて「無言で初期画面に戻った」
 * ように見える（2026-10-27 実機報告）。
 *
 * 対策: 分離の開始時にマーカーを書き、正常終了・失敗（ハンドル済み）・
 * キャンセルのいずれでも必ず消す。ページが強制終了した場合だけ
 * マーカーが残るため、次回起動時に残っていれば「前回は完了せずに
 * 終了した」とユーザーへ知らせることができる。
 *
 * sessionStorage を使う理由: タブ／セッション単位で残り、ブラウザを
 * 閉じれば消える。「前回の未完走」を伝える用途に十分で、永続化して
 * 古い通知が残り続けることもない。
 *
 * ストレージが使えない環境（プライベートモード等で例外が出る場合）
 * でもアプリ本体を壊さないよう、全関数は例外を外へ漏らさない。
 */

export const SEPARATION_MARKER_KEY = "ca:separationInProgress";

export interface SeparationInProgressMarker {
  /** 分離を開始した時刻（Date.now()） */
  startedAt: number;
  /** 対象ファイル名（通知での手がかり） */
  fileName: string;
  /** 実行モード。マーカーを立てるのは高精度モードのみ */
  mode: "high-accuracy";
}

/** Storage の最小インタフェース（テストで差し替え可能にする） */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function defaultStorage(): StorageLike | null {
  try {
    return typeof sessionStorage !== "undefined" ? sessionStorage : null;
  } catch {
    return null;
  }
}

function resolveStorage(storage?: StorageLike | null): StorageLike | null {
  return storage === undefined ? defaultStorage() : storage;
}

/** 分離の開始を記録する。失敗しても例外は投げない */
export function markSeparationStarted(
  fileName: string,
  storage?: StorageLike | null,
  now: number = Date.now(),
): void {
  const store = resolveStorage(storage);
  if (!store) return;
  const marker: SeparationInProgressMarker = {
    startedAt: now,
    fileName,
    mode: "high-accuracy",
  };
  try {
    store.setItem(SEPARATION_MARKER_KEY, JSON.stringify(marker));
  } catch {
    // ストレージ書き込み失敗は本処理に影響させない
  }
}

/** マーカーを消す（正常終了・ハンドル済み失敗・キャンセルの各経路から呼ぶ） */
export function clearSeparationMarker(storage?: StorageLike | null): void {
  const store = resolveStorage(storage);
  if (!store) return;
  try {
    store.removeItem(SEPARATION_MARKER_KEY);
  } catch {
    // 同上
  }
}

/** マーカーを読む。無い／壊れている場合は null */
export function readSeparationMarker(
  storage?: StorageLike | null,
): SeparationInProgressMarker | null {
  const store = resolveStorage(storage);
  if (!store) return null;
  let raw: string | null;
  try {
    raw = store.getItem(SEPARATION_MARKER_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as { startedAt?: unknown }).startedAt === "number" &&
      typeof (parsed as { fileName?: unknown }).fileName === "string" &&
      (parsed as { mode?: unknown }).mode === "high-accuracy"
    ) {
      return parsed as SeparationInProgressMarker;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * マーカーを読んで消す（起動時チェック用）。
 * 残っていたマーカーは「前回の分離がハンドラを経ずに終わった」証拠。
 */
export function takeSeparationMarker(
  storage?: StorageLike | null,
): SeparationInProgressMarker | null {
  const marker = readSeparationMarker(storage);
  if (marker) clearSeparationMarker(storage);
  return marker;
}

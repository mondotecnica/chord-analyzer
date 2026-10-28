import type { StorageLike } from "./separationMarker";

/**
 * 分離モデルの「キャッシュ保存できた前歴」フラグ（localStorage）。
 *
 * 背景: モデル（約172MB）は Cache Storage に保存して再利用する設計だが、
 * ブラウザの容量制限やストレージ逼迫時の消去でキャッシュが静かに
 * 失われることがある。保存の成否自体も従来は握りつぶされていたため、
 * 「前回は保存できていたはずなのに今回はキャッシュを引けなかった」
 * という消失イベントを検出する手がかりが無かった（2026-10-28 報告）。
 *
 * このフラグは「過去に一度でも保存が成功した」という事実だけを覚える。
 * フラグがあるのにキャッシュを引けない回は「消失」とみなして
 * ユーザーへ知らせる材料にする。モデル本体はここには入らない
 * （入るのは小さな JSON のみ）。
 *
 * ストレージ例外や壊れたデータでアプリ本体を壊さないよう、
 * 全関数は例外を外へ漏らさず、壊れた記録は「前歴なし」として扱う。
 */

export const MODEL_CACHED_KEY = "ca:modelCached";

export interface ModelCachedRecord {
  /** 保存が成功した時刻（Date.now()） */
  cachedAt: number;
}

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

function resolveStorage(storage?: StorageLike | null): StorageLike | null {
  return storage === undefined ? defaultStorage() : storage;
}

/** 保存できた前歴の記録を読む。無い／壊れている場合は null */
export function readModelCachedRecord(
  storage?: StorageLike | null,
): ModelCachedRecord | null {
  const store = resolveStorage(storage);
  if (!store) return null;
  let raw: string | null;
  try {
    raw = store.getItem(MODEL_CACHED_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as { cachedAt?: unknown }).cachedAt === "number" &&
      Number.isFinite((parsed as { cachedAt: number }).cachedAt)
    ) {
      return parsed as ModelCachedRecord;
    }
    return null;
  } catch {
    return null;
  }
}

/** 過去にモデルの保存が成功したことがあるか */
export function wasModelCachedBefore(storage?: StorageLike | null): boolean {
  return readModelCachedRecord(storage) !== null;
}

/** モデルの保存成功を記録する。失敗しても例外は投げない */
export function markModelCached(
  storage?: StorageLike | null,
  now: number = Date.now(),
): void {
  const store = resolveStorage(storage);
  if (!store) return;
  const record: ModelCachedRecord = { cachedAt: now };
  try {
    store.setItem(MODEL_CACHED_KEY, JSON.stringify(record));
  } catch {
    // ストレージ書き込み失敗は本処理に影響させない
  }
}

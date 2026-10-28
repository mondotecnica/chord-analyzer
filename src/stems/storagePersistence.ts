/**
 * ブラウザの永続ストレージ要求と使用量の読み取り（診断用）。
 *
 * Cache Storage に保存した分離モデルは、ストレージ逼迫時にブラウザの
 * 判断で消去されうる（ベストエフォート保存）。navigator.storage.persist()
 * で永続化を要求しておくと消去されにくくなるため、高精度モードの
 * 実行時にベストエフォートで要求する。あわせて estimate() で
 * 使用量／上限を読み、保存失敗時の診断材料として記録に残す。
 *
 * どの API が欠けていても、例外が出ても、本処理（分離）は止めない。
 * 取れなかった項目は null で返し、「不明」と「0」を混同しない。
 */

export interface StoragePersistenceInfo {
  /** 永続化が認められたか。API が無い／判定できない場合は null */
  persistGranted: boolean | null;
  /** このオリジンのストレージ使用量（バイト）。不明な場合は null */
  usageBytes: number | null;
  /** このオリジンのストレージ上限（バイト）。不明な場合は null */
  quotaBytes: number | null;
}

/** navigator.storage の最小形（テストで差し替え可能にする） */
export interface StorageManagerLike {
  persist?: () => Promise<boolean>;
  persisted?: () => Promise<boolean>;
  estimate?: () => Promise<{ usage?: number; quota?: number }>;
}

export interface NavigatorLike {
  storage?: StorageManagerLike;
}

function defaultNavigator(): NavigatorLike | null {
  try {
    return typeof navigator !== "undefined"
      ? (navigator as NavigatorLike)
      : null;
  } catch {
    return null;
  }
}

function finiteOrNull(n: number | undefined): number | null {
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * 永続化を要求し、使用量を読む。失敗しても例外は投げず、
 * 取れた項目だけを埋めて返す（本処理をブロックしない）。
 */
export async function requestPersistentStorage(
  nav?: NavigatorLike | null,
): Promise<StoragePersistenceInfo> {
  const info: StoragePersistenceInfo = {
    persistGranted: null,
    usageBytes: null,
    quotaBytes: null,
  };
  const navigatorLike = nav === undefined ? defaultNavigator() : nav;
  const storage = navigatorLike?.storage;
  if (!storage) return info;

  if (typeof storage.persist === "function") {
    try {
      info.persistGranted = await storage.persist();
    } catch {
      // 要求の失敗は不明として扱う（本処理は止めない）
      info.persistGranted = null;
    }
  } else if (typeof storage.persisted === "function") {
    try {
      info.persistGranted = await storage.persisted();
    } catch {
      info.persistGranted = null;
    }
  }

  if (typeof storage.estimate === "function") {
    try {
      const est = await storage.estimate();
      info.usageBytes = finiteOrNull(est?.usage);
      info.quotaBytes = finiteOrNull(est?.quota);
    } catch {
      // 読めなければ不明のまま
    }
  }
  return info;
}

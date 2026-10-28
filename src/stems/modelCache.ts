import {
  markModelCached,
  wasModelCachedBefore,
} from "./modelCacheRecord";
import type { StorageLike } from "./separationMarker";
import { SeparationError } from "./types";

/**
 * 分離モデルの取得と Cache Storage への永続化（MODES.md §2.2）。
 *
 * - モデルは外部 CDN から取得し、自前ホストしない。
 * - 取得できたら Cache Storage に保存し、2 回目以降は
 *   ダウンロードなしで使う（初回のみの負担にする）。
 * - 取得したバイト列は想定サイズと照合し、不一致は失敗として扱う
 *   （壊れたモデルでセッション生成に進まない）。
 * - 音声データはここには一切関与しない。キャッシュ対象はモデルのみ。
 * - 保存の成否は握りつぶさず、取得結果（ModelFetchOutcome）として
 *   呼び出し側へ報告する。保存できなかった回や、前回保存できたのに
 *   キャッシュを引けなかった（消失）回は、UI がユーザーへ知らせる
 *   材料になる（2026-10-28 の実機報告を受けた正直化）。
 */

export interface ModelFetchProgress {
  loadedBytes: number;
  /** 全体サイズ（判明している場合のみ） */
  totalBytes: number | null;
  /** 0..1（全体サイズ不明の場合は null） */
  ratio: number | null;
  fromCache: boolean;
}

/**
 * モデル取得の結果報告。取得自体の成否とは別に、「キャッシュから
 * 読めたか」「保存できたか」「保存したはずのキャッシュが消えて
 * いなかったか」を呼び出し側へ伝えるためのもの。
 */
export interface ModelFetchOutcome {
  /** キャッシュから読めた場合は true、ネットワーク取得は false */
  fromCache: boolean;
  /**
   * ダウンロード後の保存結果。true = 保存できた、false = 保存に
   * 失敗した（容量制限など）。キャッシュ読み込みの回と、保存先が
   * 無い場合は null（保存を試みていない）。
   */
  persisted: boolean | null;
  /**
   * 過去に保存が成功した記録（modelCacheRecord）があるのに、
   * 今回はキャッシュを引けずダウンロードに回った場合に true。
   * ブラウザによる消去などでキャッシュが失われたことを示す。
   */
  cacheLost: boolean;
}

/** モデル保存先の最小インタフェース（テストで差し替え可能にする） */
export interface ModelStore {
  match(url: string): Promise<ArrayBuffer | undefined>;
  /** 保存できたら true、できなければ false を返す（例外は投げない） */
  put(url: string, buffer: ArrayBuffer): Promise<boolean>;
}

/** Cache Storage を使う既定の ModelStore */
export function createCacheStorageStore(cacheName: string): ModelStore {
  return {
    async match(url) {
      try {
        const cache = await caches.open(cacheName);
        const res = await cache.match(url);
        return res ? await res.arrayBuffer() : undefined;
      } catch {
        return undefined;
      }
    },
    async put(url, buffer) {
      try {
        const cache = await caches.open(cacheName);
        await cache.put(
          url,
          new Response(buffer, {
            headers: { "Content-Type": "application/octet-stream" },
          }),
        );
        return true;
      } catch {
        // 保存できなくても取得自体は成功として扱うが、失敗した事実は
        // false として呼び出し側へ返す（握りつぶさない）。
        return false;
      }
    },
  };
}

export interface FetchModelOptions {
  url: string;
  /** 想定サイズ（バイト）。指定時は取得結果と照合する */
  expectedBytes?: number;
  store?: ModelStore;
  fetchImpl?: typeof fetch;
  onProgress?: (p: ModelFetchProgress) => void;
  /** 取得結果（キャッシュ由来か／保存できたか／消失か）の報告先 */
  onOutcome?: (o: ModelFetchOutcome) => void;
  /**
   * 「保存できた前歴」フラグ（modelCacheRecord）の保存先。
   * 未指定は localStorage、null はフラグ追跡を無効化する。
   */
  cacheRecordStorage?: StorageLike | null;
  signal?: AbortSignal;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
}

/**
 * モデルを取得する（キャッシュ優先）。
 * 失敗時は SeparationError（stage: "model-download"）を投げる。
 * キャンセル時は AbortError をそのまま伝播させる（呼び出し側で区別する）。
 */
export async function fetchModelBuffer(
  options: FetchModelOptions,
): Promise<ArrayBuffer> {
  const { url, expectedBytes, store, onProgress, onOutcome, signal } = options;
  const fetchImpl = options.fetchImpl ?? fetch;

  throwIfAborted(signal);

  // 「前回までに保存できたはずか」を先に見る。保存先が無い構成では
  // キャッシュ自体が存在しないため、消失の判定対象にしない。
  const cachedBefore = store
    ? wasModelCachedBefore(options.cacheRecordStorage)
    : false;

  if (store) {
    const cached = await store.match(url);
    if (cached) {
      if (expectedBytes !== undefined && cached.byteLength !== expectedBytes) {
        // サイズの合わないキャッシュは壊れているとみなし、破棄して再取得する
        // （ModelStore に削除はないため、再取得結果で上書きされる）
      } else {
        onProgress?.({
          loadedBytes: cached.byteLength,
          totalBytes: cached.byteLength,
          ratio: 1,
          fromCache: true,
        });
        onOutcome?.({ fromCache: true, persisted: null, cacheLost: false });
        return cached;
      }
    }
  }

  let buffer: ArrayBuffer;
  try {
    const res = await fetchImpl(url, { signal });
    if (!res.ok) {
      throw new SeparationError(
        "model-download",
        `モデルを取得できませんでした（HTTP ${res.status}）。`,
      );
    }
    const totalHeader = res.headers.get("Content-Length");
    const total = totalHeader ? Number(totalHeader) : null;
    if (res.body && typeof res.body.getReader === "function") {
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let loaded = 0;
      for (;;) {
        throwIfAborted(signal);
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          chunks.push(value);
          loaded += value.byteLength;
          onProgress?.({
            loadedBytes: loaded,
            totalBytes: total,
            ratio: total ? loaded / total : null,
            fromCache: false,
          });
        }
      }
      const merged = new Uint8Array(loaded);
      let offset = 0;
      for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
      }
      buffer = merged.buffer;
    } else {
      buffer = await res.arrayBuffer();
      onProgress?.({
        loadedBytes: buffer.byteLength,
        totalBytes: total,
        ratio: total ? buffer.byteLength / total : null,
        fromCache: false,
      });
    }
  } catch (e) {
    if (e instanceof SeparationError) throw e;
    if (signal?.aborted) throw e; // キャンセルはそのまま伝播
    throw new SeparationError(
      "model-download",
      "モデルを取得できませんでした。ネットワーク接続を確認してください。",
      { cause: e },
    );
  }

  if (expectedBytes !== undefined && buffer.byteLength !== expectedBytes) {
    throw new SeparationError(
      "model-download",
      `モデルのサイズが想定と一致しませんでした（${buffer.byteLength} バイト）。`,
    );
  }

  // ダウンロードできた場合は保存を試み、成否を結果として報告する。
  // 前歴があるのにここへ来た = キャッシュが失われていた（消失）。
  let persisted: boolean | null = null;
  if (store) {
    persisted = await store.put(url, buffer);
    if (persisted) {
      markModelCached(options.cacheRecordStorage);
    }
  }
  onOutcome?.({
    fromCache: false,
    persisted,
    cacheLost: store ? cachedBefore : false,
  });
  return buffer;
}

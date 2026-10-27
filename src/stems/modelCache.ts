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
 */

export interface ModelFetchProgress {
  loadedBytes: number;
  /** 全体サイズ（判明している場合のみ） */
  totalBytes: number | null;
  /** 0..1（全体サイズ不明の場合は null） */
  ratio: number | null;
  fromCache: boolean;
}

/** モデル保存先の最小インタフェース（テストで差し替え可能にする） */
export interface ModelStore {
  match(url: string): Promise<ArrayBuffer | undefined>;
  put(url: string, buffer: ArrayBuffer): Promise<void>;
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
      } catch {
        // 保存できなくても取得自体は成功として扱う（次回再取得になるだけ）
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
  const { url, expectedBytes, store, onProgress, signal } = options;
  const fetchImpl = options.fetchImpl ?? fetch;

  throwIfAborted(signal);

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

  if (store) {
    await store.put(url, buffer);
  }
  return buffer;
}

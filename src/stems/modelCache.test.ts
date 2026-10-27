import { describe, expect, it, vi } from "vitest";
import {
  fetchModelBuffer,
  type ModelFetchProgress,
  type ModelStore,
} from "./modelCache";
import { SeparationError } from "./types";

const URL = "https://example.test/model.onnx";

class FakeStore implements ModelStore {
  readonly data = new Map<string, ArrayBuffer>();
  async match(url: string): Promise<ArrayBuffer | undefined> {
    return this.data.get(url);
  }
  async put(url: string, buffer: ArrayBuffer): Promise<void> {
    this.data.set(url, buffer);
  }
}

function streamingFetch(bytes: Uint8Array, chunkSize = 2): typeof fetch {
  return vi.fn(async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += chunkSize) {
          controller.enqueue(bytes.subarray(i, i + chunkSize));
        }
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "Content-Length": String(bytes.byteLength) },
    });
  }) as unknown as typeof fetch;
}

describe("fetchModelBuffer", () => {
  it("キャッシュにあれば取得せずに返す", async () => {
    const store = new FakeStore();
    const cached = new Uint8Array([9, 8, 7]).buffer;
    store.data.set(URL, cached);
    const fetchImpl = vi.fn(() => {
      throw new Error("fetch should not be called");
    }) as unknown as typeof fetch;
    const progresses: ModelFetchProgress[] = [];
    const result = await fetchModelBuffer({
      url: URL,
      expectedBytes: 3,
      store,
      fetchImpl,
      onProgress: (p) => progresses.push(p),
    });
    expect(new Uint8Array(result)).toEqual(new Uint8Array([9, 8, 7]));
    expect(progresses.at(-1)?.fromCache).toBe(true);
  });

  it("未キャッシュならストリーミング取得し、進捗を出し、保存する", async () => {
    const store = new FakeStore();
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const progresses: ModelFetchProgress[] = [];
    const result = await fetchModelBuffer({
      url: URL,
      expectedBytes: 6,
      store,
      fetchImpl: streamingFetch(bytes),
      onProgress: (p) => progresses.push(p),
    });
    expect(new Uint8Array(result)).toEqual(bytes);
    expect(progresses.length).toBeGreaterThan(1);
    expect(progresses.at(-1)?.ratio).toBe(1);
    expect(progresses.every((p) => !p.fromCache)).toBe(true);
    expect(store.data.has(URL)).toBe(true);
  });

  it("サイズ不一致は SeparationError（model-download）", async () => {
    await expect(
      fetchModelBuffer({
        url: URL,
        expectedBytes: 10,
        fetchImpl: streamingFetch(new Uint8Array([1, 2, 3])),
      }),
    ).rejects.toMatchObject({ name: "SeparationError", stage: "model-download" });
  });

  it("HTTP エラーは SeparationError（model-download）", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("not found", { status: 404 }),
    ) as unknown as typeof fetch;
    await expect(fetchModelBuffer({ url: URL, fetchImpl })).rejects.toBeInstanceOf(
      SeparationError,
    );
  });

  it("ネットワーク例外は SeparationError に包む", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(fetchModelBuffer({ url: URL, fetchImpl })).rejects.toMatchObject({
      stage: "model-download",
    });
  });

  it("body の無い応答では arrayBuffer 経由で取得する", async () => {
    const bytes = new Uint8Array([5, 4, 3, 2]);
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: null,
      arrayBuffer: async () => bytes.buffer,
    })) as unknown as typeof fetch;
    const result = await fetchModelBuffer({ url: URL, expectedBytes: 4, fetchImpl });
    expect(new Uint8Array(result)).toEqual(bytes);
  });
});

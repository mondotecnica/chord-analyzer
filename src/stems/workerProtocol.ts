import type { ExecutionProvider } from "./environment";

/**
 * 分離 Worker とメインスレッド間のメッセージ型（MODES.md §2.1）。
 * チャンク単位で往復する: メイン → init（モデル一式）→ chunk × N、
 * Worker → ready / chunk-done / error。
 */

export interface WorkerInitRequest {
  type: "init";
  /** モデル本体（転送される） */
  modelBuffer: ArrayBuffer;
  /** 実行プロバイダの優先順位 */
  providers: ExecutionProvider[];
}

export interface WorkerChunkRequest {
  type: "chunk";
  index: number;
  /** チャンクのステレオ波形（転送される。長さはチャンク長で統一） */
  left: Float32Array;
  right: Float32Array;
}

export type WorkerRequest = WorkerInitRequest | WorkerChunkRequest;

export interface WorkerReadyResponse {
  type: "ready";
  /** 実際にセッション生成に使ったプロバイダ */
  providers: string[];
}

export interface WorkerChunkDoneResponse {
  type: "chunk-done";
  index: number;
  /**
   * チャンク分の分離結果。チャンネル並びは STEM_NAMES の順で
   * [drums L, drums R, bass L, bass R, other L, other R, vocals L, vocals R]
   */
  channels: Float32Array[];
}

export interface WorkerErrorResponse {
  type: "error";
  stage: "runtime-init" | "inference";
  message: string;
}

export type WorkerResponse =
  | WorkerReadyResponse
  | WorkerChunkDoneResponse
  | WorkerErrorResponse;

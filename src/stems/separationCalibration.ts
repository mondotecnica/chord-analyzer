import type { ExecutionProvider } from "./environment";
import type { StorageLike } from "./separationMarker";

/**
 * 高精度モードの待ち時間見積もりの自己キャリブレーション（localStorage）。
 *
 * 背景: 2026-10-28 の実機報告で、非力な PC（Linux Mint / Core i3 /
 * メモリ 8GB）では 3 分 25 秒の曲の初回処理に 20 分以上かかった。
 * UI の「数分」という一律の見積もりは端末性能で大きく外れるため、
 * この端末での直近の実績（分離秒数 ÷ 曲の秒数 = 比率）を覚えておき、
 * 次回以降の見積もりに使う。
 *
 * - 保存するのは最新の 1 件のみ。履歴の平均は持たない（端末の素性は
 *   そう頻繁に変わらず、古い実績を引きずる方が見積もりを濁らせる。
 *   必要になれば保存形式を保ったまま拡張できる）。
 * - 比率の算出に使うのは分離本体の時間だけ。モデルのダウンロードは
 *   初回のみで性質が違うため含めない（SeparationTimings が分けて持つ）。
 * - localStorage を使う理由: 端末の性能特性はタブを跨いで保持したい
 *   永続的な情報だから。sessionStorage の実行中マーカーとは役割が違う。
 * - ストレージ例外や壊れたデータでアプリ本体を壊さないよう、
 *   全関数は例外を外へ漏らさず、壊れた記録は「記録なし」として扱う。
 */

export const SEPARATION_CALIBRATION_KEY = "ca:separationCalibration";

/** 較正記録（この端末での直近の分離実績） */
export interface SeparationCalibration {
  /** 分離本体の秒数 ÷ 曲の秒数（例: 20 分 ÷ 3 分 25 秒 ≈ 5.85） */
  ratio: number;
  /** 実績を出した実行プロバイダ。不明な場合は未設定 */
  provider?: ExecutionProvider;
  /** 記録した時刻（Date.now()） */
  updatedAt: number;
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

function isPositiveFinite(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

/**
 * 分離本体の実測から比率（分離秒数 ÷ 曲の秒数）を計算する。
 * 入力が不正（0 以下・非有限）なら null。
 */
export function computeSeparationRatio(
  separationSeconds: number,
  audioSeconds: number,
): number | null {
  if (!isPositiveFinite(separationSeconds) || !isPositiveFinite(audioSeconds)) {
    return null;
  }
  return separationSeconds / audioSeconds;
}

/** 実測から較正記録を組み立てる。比率が作れなければ null */
export function buildSeparationCalibration(
  separationSeconds: number,
  audioSeconds: number,
  provider?: ExecutionProvider,
  now: number = Date.now(),
): SeparationCalibration | null {
  const ratio = computeSeparationRatio(separationSeconds, audioSeconds);
  if (ratio === null) return null;
  return {
    ratio,
    ...(provider ? { provider } : {}),
    updatedAt: now,
  };
}

export function serializeSeparationCalibration(
  record: SeparationCalibration,
): string {
  return JSON.stringify(record);
}

/**
 * 保存文字列を較正記録として読む。無い／壊れている／値が非常識な
 * 場合は null（＝記録なし扱い）。
 */
export function parseSeparationCalibration(
  raw: string | null,
): SeparationCalibration | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { ratio, provider, updatedAt } = parsed as {
      ratio?: unknown;
      provider?: unknown;
      updatedAt?: unknown;
    };
    // 比率は正の有限数であること。極端な値（壊れた記録や手編集）は弾く
    if (!isPositiveFinite(ratio) || ratio > 10_000) return null;
    if (typeof updatedAt !== "number" || !Number.isFinite(updatedAt)) {
      return null;
    }
    if (
      provider !== undefined &&
      provider !== "webgpu" &&
      provider !== "wasm"
    ) {
      return null;
    }
    return {
      ratio,
      ...(provider !== undefined ? { provider } : {}),
      updatedAt,
    };
  } catch {
    return null;
  }
}

/** 記録済みの比率から、対象の曲の分離所要秒数を見積もる */
export function estimateSeparationSeconds(
  record: SeparationCalibration | null,
  audioSeconds: number,
): number | null {
  if (!record || !isPositiveFinite(audioSeconds)) return null;
  return record.ratio * audioSeconds;
}

/**
 * 秒数を表示用の概算文字列にする（「約45秒」「約20分」）。
 * 見積もり表示のための丸めであり、精密な時間表示には使わない。
 */
export function formatApproxDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "約0秒";
  if (seconds < 60) return `約${Math.max(1, Math.round(seconds))}秒`;
  return `約${Math.round(seconds / 60)}分`;
}

/** 較正記録を読む。無い／壊れている場合は null */
export function loadSeparationCalibration(
  storage?: StorageLike | null,
): SeparationCalibration | null {
  const store = resolveStorage(storage);
  if (!store) return null;
  let raw: string | null;
  try {
    raw = store.getItem(SEPARATION_CALIBRATION_KEY);
  } catch {
    return null;
  }
  return parseSeparationCalibration(raw);
}

/** 較正記録を保存する。失敗しても例外は投げない */
export function saveSeparationCalibration(
  record: SeparationCalibration,
  storage?: StorageLike | null,
): void {
  const store = resolveStorage(storage);
  if (!store) return;
  try {
    store.setItem(
      SEPARATION_CALIBRATION_KEY,
      serializeSeparationCalibration(record),
    );
  } catch {
    // ストレージ書き込み失敗は本処理に影響させない
  }
}

/**
 * 分離の成功実績を記録する（組み立て → 保存）。
 * 記録できたらその記録を、できなければ null を返す。
 */
export function recordSeparationCalibration(
  separationSeconds: number,
  audioSeconds: number,
  provider?: ExecutionProvider,
  storage?: StorageLike | null,
  now: number = Date.now(),
): SeparationCalibration | null {
  const record = buildSeparationCalibration(
    separationSeconds,
    audioSeconds,
    provider,
    now,
  );
  if (!record) return null;
  saveSeparationCalibration(record, storage);
  return record;
}

/**
 * 高精度モードの実行環境検出（MODES.md §3）。
 *
 * 検出は「弾く」ためではなく「注記と実行プロバイダ選択」のため。
 * スマホ／タブレットでもハードブロックはせず、デスクトップ推奨の
 * 注記を出すに留める（メモリ上限は端末差が大きく、一律禁止すると
 * 動く端末まで排除してしまうため）。
 */

export type ExecutionProvider = "webgpu" | "wasm";

export interface EnvironmentInfo {
  /** WebGPU が使えそうか（navigator.gpu の有無） */
  hasWebGPU: boolean;
  /** WebAssembly が使えるか（フォールバック先） */
  hasWasm: boolean;
  /** navigator.deviceMemory（GB、取得できる環境のみ。それ以外は null） */
  deviceMemoryGB: number | null;
  /** タッチ主体のポインタか（matchMedia "(pointer: coarse)"） */
  isCoarsePointer: boolean;
  /** 小さい画面か（幅 820px 以下を目安に判定） */
  isSmallScreen: boolean;
  /** デスクトップ推奨の注記を出すべき環境か */
  recommendDesktop: boolean;
  /** 高精度モードを試行できる最低条件（WebGPU か WASM がある） */
  canAttemptHighAccuracy: boolean;
}

/** detectEnvironment が参照する最小限の形（テストで差し替え可能にする） */
export interface NavigatorLike {
  gpu?: unknown;
  deviceMemory?: number;
  userAgent?: string;
}
export interface WindowLike {
  innerWidth?: number;
  matchMedia?: (query: string) => { matches: boolean };
}

function wasmSupported(): boolean {
  try {
    if (typeof WebAssembly !== "object") return false;
    if (typeof WebAssembly.validate !== "function") return false;
    // 最小の有効なモジュール（マジック + バージョン）で検証する
    return WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
  } catch {
    return false;
  }
}

/**
 * 実行環境を検出する。引数を省略すると実際の navigator / window を見る。
 * ブラウザ外（テスト等）でも例外を投げず、不明な項目は false / null で返す。
 */
export function detectEnvironment(
  nav?: NavigatorLike | null,
  win?: WindowLike | null,
): EnvironmentInfo {
  const n: NavigatorLike | null =
    nav !== undefined
      ? nav
      : typeof navigator !== "undefined"
        ? (navigator as NavigatorLike)
        : null;
  const w: WindowLike | null =
    win !== undefined
      ? win
      : typeof window !== "undefined"
        ? (window as WindowLike)
        : null;

  const hasWebGPU = Boolean(n && "gpu" in n && n.gpu);
  const hasWasm = wasmSupported();
  const deviceMemoryGB =
    n && typeof n.deviceMemory === "number" ? n.deviceMemory : null;

  let isCoarsePointer = false;
  try {
    isCoarsePointer = Boolean(
      w?.matchMedia?.("(pointer: coarse)").matches,
    );
  } catch {
    isCoarsePointer = false;
  }
  const isSmallScreen =
    typeof w?.innerWidth === "number" ? w.innerWidth <= 820 : false;

  return {
    hasWebGPU,
    hasWasm,
    deviceMemoryGB,
    isCoarsePointer,
    isSmallScreen,
    recommendDesktop: isCoarsePointer || isSmallScreen,
    canAttemptHighAccuracy: hasWebGPU || hasWasm,
  };
}

/**
 * ONNX Runtime Web へ渡す実行プロバイダの優先順位。
 * WebGPU があれば第一候補にし、WASM をフォールバックとして続ける
 * （ORT 側が WebGPU 初期化に失敗した場合は WASM へ落ちる）。
 * どちらも無ければ空配列（＝試行不可能）。
 */
export function selectExecutionProviders(
  env: Pick<EnvironmentInfo, "hasWebGPU" | "hasWasm">,
): ExecutionProvider[] {
  if (env.hasWebGPU && env.hasWasm) return ["webgpu", "wasm"];
  if (env.hasWebGPU) return ["webgpu"];
  if (env.hasWasm) return ["wasm"];
  return [];
}

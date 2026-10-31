/** 診断（一回限り）: 宵のひかり素材のクロマ回転チェック。 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import { runDiagnostic } from "./sunoYoiChromaDiagnostic";

const ready = existsSync(
  join(fileURLToPath(new URL("..", import.meta.url)), "stem-work/suno-yoi/mix.wav"),
);

describe("診断: クロマ回転", () => {
  (ready ? it : it.skip)("各ファイルの平均クロマと 05 基準の最適回転を出す", () => {
    const out = runDiagnostic();
    console.log(JSON.stringify(out, null, 1));
  }, 600_000);
});

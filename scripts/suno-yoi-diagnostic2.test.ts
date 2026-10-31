/** 診断2（一回限り）: 48kHz クロマ回転の切り分け。 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import { runDiagnostic2 } from "./sunoYoiChromaDiagnostic2";

const ready = existsSync(
  join(fileURLToPath(new URL("..", import.meta.url)), "stem-work/suno-yoi/mix44.wav"),
);

describe("診断2: SR 依存の切り分け", () => {
  (ready ? it : it.skip)("合成和音と実素材コントロールを測る", async () => {
    const out = await runDiagnostic2();
    console.log(JSON.stringify(out, null, 1));
  }, 900_000);
});

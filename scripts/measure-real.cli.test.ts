/**
 * 実曲測定ハーネスの CLI 入口（vitest 経由）。
 * 通常は scripts/measure-real-launcher.mjs が環境変数を設定して起動する:
 *   npm run measure:real -- --audio <file> --truth <truth.json> [--out <dir>]
 * 環境変数が無い通常の `npm test` ではスキップされる。
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runRealMeasurement } from "./measureReal";

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const audio = process.env.MEASURE_REAL_AUDIO;
const truth = process.env.MEASURE_REAL_TRUTH;
const out = process.env.MEASURE_REAL_OUT;

const pct = (x: number | null) => (x === null ? "—" : `${(x * 100).toFixed(1)}%`);

describe.skipIf(!audio || !truth)("実曲測定（CLI）", () => {
  it("設定マトリクスで測定し、レポートを書き出す", async () => {
    const run = await runRealMeasurement({
      audioPath: resolve(audio!),
      truthPath: resolve(truth!),
      outDir: out ? resolve(out) : undefined,
      projectRoot: PROJECT_ROOT,
    });
    for (const { config, measurement: m } of run.configs) {
      // eslint-disable-next-line no-console
      console.log(
        `${config.id}: root ${pct(m.rootAccuracy)} / triad ${pct(m.triadAccuracy)} / core ${pct(m.coreAccuracy)} / N.C. ${pct(m.ncShare)} / key ${m.detectedKey} / bpm ${m.detectedBpm ?? "—"}`,
      );
    }
    expect(run.configs.length).toBeGreaterThan(0);
  }, 600_000);
});

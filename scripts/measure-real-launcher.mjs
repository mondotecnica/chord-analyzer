#!/usr/bin/env node
/**
 * 実曲測定の CLI ランチャー。
 *   npm run measure:real -- --audio <file> --truth <truth.json> [--out <dir>]
 * 引数を環境変数に変換し、vitest 経由で scripts/measure-real.cli.test.ts を実行する
 * （このプロジェクトの TS ハーネスはすべて vitest 経由で実行する既存方式に合わせた）。
 */
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--audio") out.audio = argv[++i];
    else if (a === "--truth") out.truth = argv[++i];
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--help" || a === "-h") out.help = true;
    else throw new Error(`未知の引数: ${a}`);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help || !args.audio || !args.truth) {
  console.error(
    "使い方: npm run measure:real -- --audio <音声ファイル> --truth <正解JSON> [--out <出力ディレクトリ>]",
  );
  process.exit(args.help ? 0 : 1);
}

const env = {
  ...process.env,
  MEASURE_REAL_AUDIO: resolve(args.audio),
  MEASURE_REAL_TRUTH: resolve(args.truth),
  ...(args.out ? { MEASURE_REAL_OUT: resolve(args.out) } : {}),
};

const vitestEntry = join(PROJECT_ROOT, "node_modules", "vitest", "vitest.mjs");
const child = spawnSync(
  process.execPath,
  [vitestEntry, "run", "scripts/measure-real.cli.test.ts"],
  { cwd: PROJECT_ROOT, env, stdio: "inherit" },
);
process.exit(child.status ?? 1);

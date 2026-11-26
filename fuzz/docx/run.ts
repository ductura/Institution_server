// Local command and body of the manual workflow for the DOCX import fuzzer (ISTR-8):
//   node fuzz/docx/run.ts [seconds]      (default 60)
// Bundles `target.ts` to CommonJS, copies the seed corpus (the ISTR-6 fixtures and
// the committed regressions) into a scratch corpus under dist/, and runs Jazzer.js
// with a time limit per input (-timeout), a size limit (-max_len) and a total limit.
// The exit code is Jazzer's: non-zero when it found a crash, a hang or an out-of-memory.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

import { FUZZ_MAX_INPUT_BYTES } from "./target.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const out = join(here, "dist");
const corpus = join(out, "corpus");
const seedDirs = [join(root, "test-support/docx-zip/mammoth"), join(here, "regressions")];
const PER_INPUT_SECONDS = 5;
const RSS_LIMIT_MB = 2048;

const seconds = Number(process.argv[2] ?? 60);
if (!Number.isSafeInteger(seconds) || seconds < 1)
  throw new Error("seconds must be a positive integer");

rmSync(out, { recursive: true, force: true });
mkdirSync(corpus, { recursive: true });
let seeds = 0;
for (const dir of seedDirs) {
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".docx") && !name.endsWith(".bin")) continue;
    copyFileSync(join(dir, name), join(corpus, `${seeds++}-${name}`));
  }
}

await build({
  absWorkingDir: root,
  entryPoints: ["fuzz/docx/target.ts"],
  outfile: join(out, "target.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  sourcemap: "inline",
  logLevel: "warning",
});

const jazzer = join(here, "node_modules/.bin/jazzer");
const result = spawnSync(
  jazzer,
  [
    join(out, "target.cjs"),
    corpus,
    "--sync",
    "--",
    `-max_total_time=${seconds}`,
    `-timeout=${PER_INPUT_SECONDS}`,
    `-max_len=${FUZZ_MAX_INPUT_BYTES}`,
    `-rss_limit_mb=${RSS_LIMIT_MB}`,
    `-artifact_prefix=${out}/`,
  ],
  { cwd: out, stdio: "inherit" },
);
if (result.error) throw result.error;
console.log(`seeds: ${seeds}; crash files, if any, are in ${out}`);
process.exit(result.status ?? 1);

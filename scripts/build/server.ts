// Builds the one entry point server/server.ts into one file, dist/server.js
// (S-1B-a, DAN-775). Dependencies are bundled, so the file runs with node and
// nothing else; pg-native stays out because pg loads it only on request.
import { realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build, type BuildOptions, type Plugin } from "esbuild";

export const ENTRY = "server/server.ts";
export const OUTFILE = "dist/server.js";
// The PDF reader's thread (SRV-1804B, import-contract D4): a second, static
// entry built next to the server file, where server/import/pdf/worker.ts looks
// for it (`new URL("./pdf-import-worker.js", import.meta.url)`).
export const PDF_WORKER_ENTRY = "server/import/pdf/worker-thread.ts";
export const PDF_WORKER_FILE = "pdf-import-worker.js";

/**
 * Bundles the entry into `outfile`; the root is the repository. `plugins` is
 * for tests only (DAN-911-2 swaps one module for a broken one); `pnpm build`
 * passes none.
 */
export async function buildServer(
  root: string,
  outfile: string = OUTFILE,
  plugins: readonly Plugin[] = [],
): Promise<void> {
  const shared: BuildOptions = {
    absWorkingDir: root,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    external: ["pg-native"],
    // CommonJS dependencies (pg) call require; an ES module has none of its own.
    banner: {
      js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
    },
    logLevel: "warning",
    plugins: [...plugins],
  };
  await build({ ...shared, entryPoints: [ENTRY], outfile });
  await build({
    ...shared,
    entryPoints: [PDF_WORKER_ENTRY],
    outfile: join(dirname(resolve(root, outfile)), PDF_WORKER_FILE),
  });
}

// argv[1] keeps a symlinked path, import.meta.url is the real one. An
// optional argument names another output file (scripts/build/server.integration.test.ts).
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outfile = process.argv[2] === undefined ? OUTFILE : resolve(process.argv[2]);
  await buildServer(fileURLToPath(new URL("../..", import.meta.url)), outfile);
}

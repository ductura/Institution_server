// Bundles the server and its static PDF import worker into adjacent files.
// pg-native stays out because pg loads it only on request.
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build, type BuildOptions, type Plugin } from "esbuild";

export const ENTRY = "server/server.ts";
export const OUTFILE = "dist/server.js";
const PDF_WORKER_ENTRY = "server/import/pdf/worker.ts";
export const PDF_WORKER_OUTFILE = "pdf-import-worker.js";

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
  const options: BuildOptions = {
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
  };
  const workerOutfile = resolve(root, dirname(outfile), PDF_WORKER_OUTFILE);
  await Promise.all([
    build({ ...options, entryPoints: [ENTRY], outfile, plugins: [...plugins] }),
    build({ ...options, entryPoints: [PDF_WORKER_ENTRY], outfile: workerOutfile }),
  ]);
}

// argv[1] keeps a symlinked path, import.meta.url is the real one. An
// optional argument names another output file (scripts/build/server.integration.test.ts).
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outfile = process.argv[2] === undefined ? OUTFILE : resolve(process.argv[2]);
  await buildServer(fileURLToPath(new URL("../..", import.meta.url)), outfile);
}

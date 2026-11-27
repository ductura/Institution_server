// Bundles the server, its static PDF import worker and the worker process into adjacent files.
// pg-native stays out because pg loads it only on request.
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build, type BuildOptions, type Plugin } from "esbuild";

export const ENTRY = "server/server.ts";
export const OUTFILE = "dist/server.js";
/** The worker process (F4-PM2-R01B, D-71, D-102): its own entry point and file next to the server's. */
export const WORKER_ENTRY = "server/worker-main.ts";
export const WORKER_OUTFILE = "worker.js";
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
    // esbuild does not see the banner, so its import is aliased: a bundled ES module
    // that imports createRequire itself (fflate's node entry) must not collide with it.
    banner: {
      js: 'import { createRequire as __bannerCreateRequire } from "node:module"; const require = __bannerCreateRequire(import.meta.url);',
    },
    logLevel: "warning",
  };
  const workerOutfile = resolve(root, dirname(outfile), PDF_WORKER_OUTFILE);
  const processOutfile = resolve(root, dirname(outfile), WORKER_OUTFILE);
  await Promise.all([
    build({ ...options, entryPoints: [ENTRY], outfile, plugins: [...plugins] }),
    build({ ...options, entryPoints: [PDF_WORKER_ENTRY], outfile: workerOutfile }),
    build({ ...options, entryPoints: [WORKER_ENTRY], outfile: processOutfile }),
  ]);
}

// argv[1] keeps a symlinked path, import.meta.url is the real one. An
// optional argument names another output file (scripts/build/server.integration.test.ts).
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outfile = process.argv[2] === undefined ? OUTFILE : resolve(process.argv[2]);
  await buildServer(fileURLToPath(new URL("../..", import.meta.url)), outfile);
}

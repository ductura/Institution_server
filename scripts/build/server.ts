// Builds the one entry point server/server.ts into one file, dist/server.js
// (S-1B-a, DAN-775). Dependencies are bundled, so the file runs with node and
// nothing else; pg-native stays out because pg loads it only on request.
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build, type Plugin } from "esbuild";

export const ENTRY = "server/server.ts";
export const OUTFILE = "dist/server.js";

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
  await build({
    absWorkingDir: root,
    entryPoints: [ENTRY],
    outfile,
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
  });
}

// argv[1] keeps a symlinked path, import.meta.url is the real one. An
// optional argument names another output file (scripts/build/server.integration.test.ts).
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outfile = process.argv[2] === undefined ? OUTFILE : resolve(process.argv[2]);
  await buildServer(fileURLToPath(new URL("../..", import.meta.url)), outfile);
}

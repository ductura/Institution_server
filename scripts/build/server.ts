// Builds the one entry point server/server.ts into one file, dist/server.js
// (S-1B-a, DAN-775). Dependencies are bundled, so the file runs with node and
// nothing else; pg-native stays out because pg loads it only on request.
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

export const ENTRY = "server/server.ts";
export const OUTFILE = "dist/server.js";

/** Bundles the entry into `outfile`; the root is the repository. */
export async function buildServer(root: string, outfile: string = OUTFILE): Promise<void> {
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
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await buildServer(fileURLToPath(new URL("../..", import.meta.url)));
}

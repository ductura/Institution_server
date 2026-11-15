import { spawnSync } from "node:child_process";

import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

// `npm pack --dry-run --json` is an outside answer: one schema checks all of it
// before anything reads it. Exactly one package, every file with a path.
export const PackOutputSchema = Type.Tuple([
  Type.Object({
    name: Type.String({ minLength: 1 }),
    version: Type.String({ minLength: 1 }),
    files: Type.Array(
      Type.Object({
        // Relative, inside the package: check.ts reads every path.
        path: Type.String({ pattern: "^(?!/)(?!(?:.*/)?\\.\\.(?:/|$))[^\\\\]+$" }),
        size: Type.Integer({ minimum: 0 }),
        mode: Type.Integer({ minimum: 0 }),
      }),
    ),
  }),
]);
export type PackOutput = Static<typeof PackOutputSchema>;

/** The parsed output, or an error naming the first mismatch. */
export function parsePackOutput(text: string): PackOutput {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("npm pack: output is not JSON");
  }
  const error = Value.Errors(PackOutputSchema, value).First();
  if (error !== undefined) throw new Error(`npm pack: ${error.path || "/"} ${error.message}`);
  return value as PackOutput;
}

/** What `npm pack` would put in the tarball of the package in `dir`. */
export function packFiles(dir: string): PackOutput {
  const run = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: dir,
    encoding: "utf8",
  });
  if (run.status !== 0) throw new Error(`npm pack failed in ${dir}: ${run.stderr}`);
  return parsePackOutput(run.stdout);
}

/** Every difference between the tarball and the expected list. */
export function compareFiles(actual: readonly string[], expected: readonly string[]): string[] {
  const want = new Set(expected);
  const have = new Set(actual);
  return [
    ...[...have].filter((path) => !want.has(path)).map((path) => `unexpected file ${path}`),
    ...[...want].filter((path) => !have.has(path)).map((path) => `missing file ${path}`),
  ];
}

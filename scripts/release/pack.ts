import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { posix, win32 } from "node:path";

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

type NpmHost = {
  readonly execPath: string;
  readonly platform: NodeJS.Platform;
  readonly npmExecPath: string | undefined;
  readonly exists: (path: string) => boolean;
};

/**
 * The npm CLI script, run by node itself: no shell, so it works where npm is
 * only `npm.cmd` (Windows). npm sets `npm_execpath`; otherwise npm ships next
 * to node (Windows) or in ../lib (POSIX).
 */
export function npmCliPath(host: NpmHost): string {
  const path = host.platform === "win32" ? win32 : posix;
  // Under pnpm, npm_execpath is pnpm itself: only npm's own script counts.
  if (host.npmExecPath !== undefined && /^npm-cli\.[cm]?js$/u.test(path.basename(host.npmExecPath)))
    return host.npmExecPath;
  const bin = path.dirname(host.execPath);
  const npm = path.join("node_modules", "npm", "bin", "npm-cli.js");
  const found = path.join(bin, host.platform === "win32" ? "" : path.join("..", "lib"), npm);
  if (!host.exists(found)) throw new Error(`npm CLI not found next to ${host.execPath}`);
  return found;
}

/** What `npm pack` would put in the tarball of the package in `dir`. */
export function packFiles(dir: string): PackOutput {
  const cli = npmCliPath({
    execPath: process.execPath,
    platform: process.platform,
    npmExecPath: process.env.npm_execpath,
    exists: existsSync,
  });
  const args = [cli, "pack", "--dry-run", "--json", "--ignore-scripts"];
  const run = spawnSync(process.execPath, args, { cwd: dir, encoding: "utf8" });
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

// Fails when the contracts break a client of the OpenAPI document on a base
// revision. CI runs it on every pull request against the target branch.
// Usage: pnpm contracts:breaking [base revision, default origin/main]
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { breakingChanges } from "../server/contracts/index.ts";
import { openapiDocument } from "./generate-contracts.ts";

// openapi/v1.json; before DAN-737 the same document lived in the generated folder.
const BASE_FILES = ["openapi/v1.json", "server/contracts/generated/openapi.json"];

/**
 * Output limit for one git call. The default of execFileSync (1 MiB) is far
 * below what a published document may grow to; a larger output still throws.
 */
export const GIT_MAX_BUFFER = 256 * 1024 * 1024;

/** Runs git with the given arguments and returns its stdout; throws on any failure. */
export type Git = (args: string[]) => string;

const git: Git = (args) =>
  execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: GIT_MAX_BUFFER,
    stdio: ["ignore", "pipe", "pipe"],
  });

/**
 * The content of `file` (relative to the repository root) at `revision`, or
 * null only when that revision has no such path. Every other failure (unknown
 * revision, a directory in place of the file, output over the buffer, a git
 * error) throws, so the check can never pass because the base was unreadable.
 */
export function gitShow(revision: string, file: string, run: Git = git): string | null {
  if (run(["ls-tree", "--full-tree", "--name-only", revision, "--", file]) === "") return null;
  return run(["cat-file", "blob", `${revision}:${file}`]);
}

/**
 * The published document at `base`, or null only when that revision has none.
 * A document that is there but does not parse to a JSON object throws, so its
 * content (e.g. `null`) can never read as a missing document.
 */
export function baseDocument(
  base: string,
  show: (revision: string, file: string) => string | null = gitShow,
): unknown {
  for (const file of BASE_FILES) {
    const text = show(base, file);
    if (text === null) continue;
    const document: unknown = JSON.parse(text);
    if (typeof document !== "object" || document === null || Array.isArray(document)) {
      throw new Error(`${base}:${file} is not a JSON object`);
    }
    return document;
  }
  return null;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const base = process.argv[2] ?? "origin/main";
  execFileSync("git", ["rev-parse", "--verify", `${base}^{commit}`], { stdio: "inherit" });
  const before = baseDocument(base);
  if (before === null) {
    console.log(`contracts: ${base} has no published OpenAPI document, nothing to compare`);
  } else {
    const problems = breakingChanges(before, openapiDocument());
    if (problems.length > 0) {
      console.error(
        `contracts: ${problems.length} change(s) break clients of ${base}:\n${problems.map((p) => `  ${p}`).join("\n")}`,
      );
      process.exit(1);
    }
    console.log(`contracts: no breaking change against ${base}`);
  }
}

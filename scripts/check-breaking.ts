// Fails when the contracts break a client of the OpenAPI document on a base
// revision. CI runs it on every pull request against the target branch.
// Usage: pnpm contracts:breaking [base revision, default origin/main]
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { breakingChanges } from "../server/contracts/index.ts";
import { openapiDocument } from "./generate-contracts.ts";

// openapi/v1.json; before DAN-737 the same document lived in the generated folder.
const BASE_FILES = ["openapi/v1.json", "server/contracts/generated/openapi.json"];

/** The published document at `base`, or null when that revision has none. */
export function baseDocument(base: string, show = gitShow): unknown {
  for (const file of BASE_FILES) {
    const text = show(`${base}:${file}`);
    if (text !== null) return JSON.parse(text);
  }
  return null;
}

function gitShow(spec: string): string | null {
  try {
    return execFileSync("git", ["show", spec], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
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

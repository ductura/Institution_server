// Checks that every area folder has the files docs/CODE_STYLE.md rule 10
// asks for: index.ts, README.md, and the README template headings.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Headings of the area README template (docs/CODE_STYLE.md §10), in order. */
export const README_HEADINGS = [
  "## Što radi",
  "## Tko ga zove",
  "## Koje podatke dira",
  "## Što izvozi",
  "## Što ne smije uvoziti",
] as const;

/** Problems of one area folder (`key` as in the server map, e.g. `external/email`). */
export function checkAreaFiles(root: string, key: string): string[] {
  const dir = join(root, "server", key);
  return ["index.ts", "README.md"]
    .filter((name) => !existsSync(join(dir, name)))
    .map((name) => `server/${key}: missing ${name}`);
}

/** Template headings missing from the README of `key`; empty when it has no README. */
export function checkReadmeTemplate(root: string, key: string): string[] {
  const path = join(root, "server", key, "README.md");
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trimEnd());
  return README_HEADINGS.filter((heading) => !lines.includes(heading)).map(
    (heading) => `server/${key}/README.md: missing "${heading}"`,
  );
}

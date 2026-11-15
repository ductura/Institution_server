// Checks that every area folder has the files docs/CODE_STYLE.md rule 10
// asks for: index.ts, README.md, and the README template headings.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Headings of the area README template, read from the template block of
 * docs/CODE_STYLE.md §10, in order. They are Croatian text, which server code
 * does not write (S-1L.2, DAN-780), so the document is their only source.
 */
export function readmeHeadings(root: string): string[] {
  // Lines end in LF or CRLF (a Windows checkout with core.autocrlf).
  const doc = readFileSync(join(root, "docs", "CODE_STYLE.md"), "utf8")
    .split(/\r?\n/u)
    .map((line) => line.trimEnd());
  const section = doc.findIndex((line) => line.startsWith("## 10. "));
  const open = doc.findIndex((line, i) => i > section && line === "```md");
  const close = doc.findIndex((line, i) => i > open && line === "```");
  if (section === -1 || open === -1 || close === -1) return [];
  return doc.slice(open + 1, close).filter((line) => line.startsWith("## "));
}

/** Problems of one area folder (`key` as in the server map, e.g. `external/email`). */
export function checkAreaFiles(root: string, key: string): string[] {
  const dir = join(root, "server", key);
  return ["index.ts", "README.md"]
    .filter((name) => !existsSync(join(dir, name)))
    .map((name) => `server/${key}: missing ${name}`);
}

/** Template headings missing from the README of `key`; empty when it has no README. */
export function checkReadmeTemplate(
  root: string,
  key: string,
  headings: readonly string[],
): string[] {
  const path = join(root, "server", key, "README.md");
  if (!existsSync(path)) return [];
  // An empty template would check nothing, so it is a problem itself.
  if (headings.length === 0) return [`server/${key}/README.md: no template headings to check`];
  const lines = readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trimEnd());
  return headings
    .filter((heading) => !lines.includes(heading))
    .map((heading) => `server/${key}/README.md: missing "${heading}"`);
}

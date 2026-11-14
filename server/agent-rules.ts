// Checks for the agent instruction adapters (CLAUDE.md, AGENTS.md, .claude/rules).
// The adapters add no rules of their own: each must point to a source document,
// either a file in this repo or a known document in the Ductus repo.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const DUCTUS_BLOB_PREFIX = "https://github.com/danielrisavi77-create/Ductus/blob/main/";

/**
 * Ductus documents the adapters may link to. Each path was checked against
 * Ductus main (d52a92c, 14. 11. 2026.); CI does not reach the network, so a
 * new link needs a new entry here, checked by hand.
 */
export const DUCTUS_SOURCES: ReadonlySet<string> = new Set([
  "CLAUDE.md",
  "AGENTS.md",
  "docs/ENGINEERING_SYSTEM.md",
  "docs/ENGINEERING_SYSTEM-SAZETAK.md",
  "docs/PRODUCT.md",
  "docs/MULTI-ACCOUNT.md",
  "docs/TESTING.md",
  "docs/backend/prijava-i-ovlasti.md",
  "docs/backend/baza-i-pogon.md",
  ".claude/uloge/README.md",
  ".claude/uloge/pisac-oblak.md",
  ".claude/uloge/pisac-platforma.md",
  ".claude/rules/baza.md",
  ".claude/rules/evidencija-i-prijava.md",
  ".claude/rules/testni-podaci.md",
  ".claude/rules/sucelje.md",
  ".claude/rules/pravila-i-alati.md",
]);

const INLINE_LINK = /\[[^\]]*\]\(([^)\s]+)\)/g;

/** Every inline link target, code spans and fenced blocks excluded. */
export function extractLinks(markdown: string): string[] {
  const withoutCode = markdown.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
  return [...withoutCode.matchAll(INLINE_LINK)].map((m) => m[1] ?? "");
}

/** Path inside Ductus for a Ductus blob link (anchor dropped), otherwise null. */
export function ductusPath(link: string): string | null {
  if (!link.startsWith(DUCTUS_BLOB_PREFIX)) return null;
  return link.slice(DUCTUS_BLOB_PREFIX.length).split("#")[0] ?? "";
}

/** Problems with links that leave this repo: only known Ductus documents are allowed. */
export function externalLinkProblems(file: string, markdown: string): string[] {
  const problems: string[] = [];
  for (const link of extractLinks(markdown)) {
    if (!/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(link)) continue;
    const path = ductusPath(link);
    if (path === null) problems.push(`${file}: ${link} (not a Ductus main link)`);
    else if (!DUCTUS_SOURCES.has(path)) problems.push(`${file}: ${link} (unknown Ductus source)`);
  }
  return problems;
}

/** The `paths:` list from a rule file's front matter; empty when there is none. */
export function rulePaths(markdown: string): string[] {
  const frontMatter = /^---\n([\s\S]*?)\n---\n/.exec(markdown)?.[1];
  if (frontMatter === undefined) return [];
  const block = /^paths:\n((?:[ \t]+- .*\n?)+)/m.exec(frontMatter)?.[1] ?? "";
  return [...block.matchAll(/^[ \t]+- ["']?([^"'\n]+?)["']?\s*$/gm)].map((m) => m[1] ?? "");
}

/** First path segment of a glob must exist, so a typo in a rule's scope fails. */
export function rulePathProblems(root: string, file: string, paths: string[]): string[] {
  if (paths.length === 0) return [`${file}: no paths in front matter`];
  return paths
    .filter((glob) => {
      const first = glob.split("/")[0] ?? "";
      return first === "" || first.includes("*") || !existsSync(join(root, first));
    })
    .map((glob) => `${file}: ${glob} (first segment missing)`);
}

export function listRuleFiles(root: string): string[] {
  const dir = join(root, ".claude", "rules");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => join(dir, name));
}

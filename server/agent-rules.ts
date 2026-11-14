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
  "docs/DECISIONS.md",
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

const INLINE_LINK = /\[[^\]]*\]\(<?([^)\s>]+)>?(?:\s+"[^"]*")?\)/g;
const REFERENCE_DEFINITION = /^ {0,3}\[[^\]]+\]:\s*<?([^\s>]+)>?/gm;
const ANY_URL = /\b[a-z][a-z0-9+.-]*:\/\/[^\s)<>"'\]]+/gi;

function stripCode(markdown: string): string {
  return markdown.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
}

/** Inline and reference-definition link targets, code spans and fenced blocks excluded. */
export function extractLinks(markdown: string): string[] {
  const text = stripCode(markdown);
  return [
    ...[...text.matchAll(INLINE_LINK)].map((m) => m[1] ?? ""),
    ...[...text.matchAll(REFERENCE_DEFINITION)].map((m) => m[1] ?? ""),
  ];
}

/** Every URL in the text in any form (link, reference, autolink, bare), code excluded. */
export function extractUrls(markdown: string): string[] {
  return [...stripCode(markdown).matchAll(ANY_URL)].map((m) => m[0]);
}

/** Path inside Ductus for a Ductus blob link (anchor dropped), otherwise null. */
export function ductusPath(link: string): string | null {
  if (!link.startsWith(DUCTUS_BLOB_PREFIX)) return null;
  return link.slice(DUCTUS_BLOB_PREFIX.length).split("#")[0] ?? "";
}

/** Problems with links that leave this repo: only known Ductus documents are allowed. */
export function externalLinkProblems(file: string, markdown: string): string[] {
  const problems: string[] = [];
  const protocolRelative = extractLinks(markdown).filter((link) => link.startsWith("//"));
  for (const link of [...extractUrls(markdown), ...protocolRelative]) {
    const path = ductusPath(link);
    if (path === null) problems.push(`${file}: ${link} (not a Ductus main link)`);
    else if (!DUCTUS_SOURCES.has(path)) problems.push(`${file}: ${link} (unknown Ductus source)`);
  }
  return problems;
}

export type RuleScope = { paths: string[]; unreadable: string[] };

const PATH_ITEM = /^[ \t]+- (?:"([^"\n]+)"|'([^'\n]+)'|([^\s"'#]+))\s*$/;

/** The `paths:` list from a rule file's front matter; items it cannot read are kept apart. */
export function rulePaths(markdown: string): RuleScope {
  const scope: RuleScope = { paths: [], unreadable: [] };
  const frontMatter = /^---\n([\s\S]*?)\n---\n/.exec(markdown)?.[1];
  if (frontMatter === undefined) return scope;
  const block = /^paths:\n((?:[ \t]+- .*(?:\n|$))+)/m.exec(frontMatter)?.[1] ?? "";
  for (const line of block.split("\n").filter((l) => l.trim() !== "")) {
    const m = PATH_ITEM.exec(line);
    const path = m?.[1] ?? m?.[2] ?? m?.[3];
    if (path === undefined) scope.unreadable.push(line.trim());
    else scope.paths.push(path);
  }
  return scope;
}

/** Scope must be readable and the first segment of each glob must exist, so a typo fails. */
export function rulePathProblems(root: string, file: string, scope: RuleScope): string[] {
  const { paths, unreadable } = scope;
  if (paths.length === 0 && unreadable.length === 0) return [`${file}: no paths in front matter`];
  const bad = unreadable.map((line) => `${file}: ${line} (unreadable path item)`);
  const missing = paths
    .filter((glob) => {
      const first = glob.split("/")[0] ?? "";
      return first === "" || first.includes("*") || !existsSync(join(root, first));
    })
    .map((glob) => `${file}: ${glob} (first segment missing)`);
  return [...bad, ...missing];
}

export function listRuleFiles(root: string): string[] {
  const dir = join(root, ".claude", "rules");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => join(dir, name));
}

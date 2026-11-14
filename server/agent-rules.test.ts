import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DUCTUS_BLOB_PREFIX,
  DUCTUS_SOURCES,
  ductusPath,
  externalLinkProblems,
  extractLinks,
  listRuleFiles,
  rulePathProblems,
  rulePaths,
} from "./agent-rules.ts";
import { findBrokenLinks } from "./docs-links.ts";

const ROOT = resolve(import.meta.dirname, "..");
const ADAPTERS = [join(ROOT, "CLAUDE.md"), join(ROOT, "AGENTS.md"), ...listRuleFiles(ROOT)];

describe("helpers", () => {
  let dir = "";
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  it("extracts inline links outside code", () => {
    expect(extractLinks("[a](x.md) `[b](y.md)`\n```\n[c](z.md)\n```\n[d](https://e.invalid)")).toEqual([
      "x.md",
      "https://e.invalid",
    ]);
  });

  it("maps only Ductus main blob links to a Ductus path", () => {
    expect(ductusPath(`${DUCTUS_BLOB_PREFIX}docs/PRODUCT.md#5`)).toBe("docs/PRODUCT.md");
    expect(ductusPath("https://github.com/danielrisavi77-create/Ductus/blob/feature/CLAUDE.md")).toBeNull();
  });

  it("rejects foreign links and unknown Ductus paths, accepts known ones", () => {
    const md = [
      `[ok](${DUCTUS_BLOB_PREFIX}CLAUDE.md)`,
      `[nepoznat](${DUCTUS_BLOB_PREFIX}docs/NEMA.md)`,
      "[strani](https://example.invalid/pravila.md)",
      "[lokalni](docs/CODE_STYLE.md)",
    ].join(" ");
    expect(externalLinkProblems("F.md", md)).toEqual([
      `F.md: ${DUCTUS_BLOB_PREFIX}docs/NEMA.md (unknown Ductus source)`,
      "F.md: https://example.invalid/pravila.md (not a Ductus main link)",
    ]);
  });

  it("reads paths from front matter and reports missing or bad scopes", () => {
    dir = mkdtempSync(join(tmpdir(), "agent-rules-"));
    mkdirSync(join(dir, "db"));
    const md = '---\npaths:\n  - "db/**"\n  - \'nema/**\'\n  - "**/*.ts"\n---\n\n# Naslov\n';
    const paths = rulePaths(md);
    expect(paths).toEqual(["db/**", "nema/**", "**/*.ts"]);
    expect(rulePathProblems(dir, "R.md", paths)).toEqual([
      "R.md: nema/** (first segment missing)",
      "R.md: **/*.ts (first segment missing)",
    ]);
    expect(rulePaths("# Bez zaglavlja\n")).toEqual([]);
    expect(rulePathProblems(dir, "R.md", [])).toEqual(["R.md: no paths in front matter"]);
  });
});

describe("agent instruction adapters", () => {
  it("include CLAUDE.md, AGENTS.md and at least one rule file", () => {
    expect(listRuleFiles(ROOT).length).toBeGreaterThan(0);
  });

  it.each(ADAPTERS.map((file) => [file.slice(ROOT.length + 1), file]))(
    "%s names its sources and every link resolves",
    (_name, file) => {
      const markdown = readFileSync(file, "utf8");
      expect(extractLinks(markdown).length).toBeGreaterThan(0);
      expect(findBrokenLinks([file])).toEqual([]);
      expect(externalLinkProblems(file, markdown)).toEqual([]);
    },
  );

  it.each(listRuleFiles(ROOT).map((file) => [file.slice(ROOT.length + 1), file]))(
    "%s is a reminder with a valid scope",
    (_name, file) => {
      const markdown = readFileSync(file, "utf8");
      expect(rulePathProblems(ROOT, file, rulePaths(markdown))).toEqual([]);
      expect(markdown).toContain("Podsjetnik, ne pravilo.");
    },
  );

  it("CLAUDE.md links to the Ductus rules, gate and forbidden terms sources", () => {
    const linked = extractLinks(readFileSync(join(ROOT, "CLAUDE.md"), "utf8")).map(ductusPath);
    for (const source of ["CLAUDE.md", "docs/ENGINEERING_SYSTEM.md", "docs/PRODUCT.md"]) {
      expect(linked).toContain(source);
    }
  });

  it("every known Ductus source is used, so the list does not go stale", () => {
    const used = new Set(
      ADAPTERS.flatMap((file) => extractLinks(readFileSync(file, "utf8")).map(ductusPath)),
    );
    expect([...DUCTUS_SOURCES].filter((path) => !used.has(path))).toEqual([]);
  });
});

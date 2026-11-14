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
  extractUrls,
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

  it("extracts inline and reference links outside code", () => {
    const md =
      '[a](x.md) `[b](y.md)`\n```\n[c](z.md)\n```\n[d](https://e.invalid "t")\n[r]: docs/R.md\n';
    expect(extractLinks(md)).toEqual(["x.md", "https://e.invalid", "docs/R.md"]);
  });

  it("finds URLs in every form: titled, reference, autolink and bare", () => {
    const md = [
      '[a](https://a.invalid/1.md "naslov")',
      "[b][1]",
      "[1]: https://b.invalid/2.md",
      "<https://c.invalid/3.md>",
      "vidi https://d.invalid/4.md danas",
      "`https://e.invalid/kod.md`",
    ].join("\n");
    expect(extractUrls(md)).toEqual([
      "https://a.invalid/1.md",
      "https://b.invalid/2.md",
      "https://c.invalid/3.md",
      "https://d.invalid/4.md",
    ]);
  });

  it("maps only Ductus main blob links to a Ductus path", () => {
    expect(ductusPath(`${DUCTUS_BLOB_PREFIX}docs/PRODUCT.md#5`)).toBe("docs/PRODUCT.md");
    expect(
      ductusPath("https://github.com/danielrisavi77-create/Ductus/blob/feature/CLAUDE.md"),
    ).toBeNull();
  });

  it("rejects foreign links and unknown Ductus paths, accepts known ones", () => {
    const md = [
      `[ok](${DUCTUS_BLOB_PREFIX}CLAUDE.md)`,
      `[nepoznat](${DUCTUS_BLOB_PREFIX}docs/NEMA.md)`,
      "[strani](https://example.invalid/pravila.md)",
      "[lokalni](docs/CODE_STYLE.md)",
      "<https://example.invalid/auto.md> i gola https://example.invalid/gola.md",
      "[zp](//example.invalid/proto.md)",
    ].join(" ");
    expect(externalLinkProblems("F.md", md)).toEqual([
      `F.md: ${DUCTUS_BLOB_PREFIX}docs/NEMA.md (unknown Ductus source)`,
      "F.md: https://example.invalid/pravila.md (not a Ductus main link)",
      "F.md: https://example.invalid/auto.md (not a Ductus main link)",
      "F.md: https://example.invalid/gola.md (not a Ductus main link)",
      "F.md: //example.invalid/proto.md (not a Ductus main link)",
    ]);
  });

  it("reads paths from front matter and reports missing or bad scopes", () => {
    dir = mkdtempSync(join(tmpdir(), "agent-rules-"));
    mkdirSync(join(dir, "db"));
    const md = [
      "---",
      "paths:",
      '  - "db/**"',
      "  - 'nema/**'",
      '  - "**/*.ts"',
      "  - db/tests/**",
      '  - "db/**" # komentar',
      "---",
      "",
      "# Naslov",
    ].join("\n");
    const scope = rulePaths(md);
    expect(scope).toEqual({
      paths: ["db/**", "nema/**", "**/*.ts", "db/tests/**"],
      unreadable: ['- "db/**" # komentar'],
    });
    expect(rulePathProblems(dir, "R.md", scope)).toEqual([
      'R.md: - "db/**" # komentar (unreadable path item)',
      "R.md: nema/** (first segment missing)",
      "R.md: **/*.ts (first segment missing)",
    ]);
    const empty = rulePaths("# Bez zaglavlja\n");
    expect(empty).toEqual({ paths: [], unreadable: [] });
    expect(rulePathProblems(dir, "R.md", empty)).toEqual(["R.md: no paths in front matter"]);
  });
});

describe("agent instruction adapters", () => {
  it("include CLAUDE.md, AGENTS.md and at least one rule file", () => {
    expect(listRuleFiles(ROOT).length).toBeGreaterThan(0);
  });

  it.each(ADAPTERS.map((file) => [file.slice(ROOT.length + 1), file]))(
    "%s names a Ductus source and every link resolves",
    (name, file) => {
      const markdown = readFileSync(file, "utf8");
      expect(extractUrls(markdown).some((url) => ductusPath(url) !== null)).toBe(true);
      expect(findBrokenLinks([file])).toEqual([]);
      expect(externalLinkProblems(file, markdown)).toEqual([]);
    },
  );

  it.each(listRuleFiles(ROOT).map((file) => [file.slice(ROOT.length + 1), file]))(
    "%s is a reminder with a valid scope",
    (name, file) => {
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
      ADAPTERS.flatMap((file) => extractUrls(readFileSync(file, "utf8")).map(ductusPath)),
    );
    expect([...DUCTUS_SOURCES].filter((path) => !used.has(path))).toEqual([]);
  });
});

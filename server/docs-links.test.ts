import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  extractRelativeLinks,
  findBrokenLinks,
  headingSlugs,
  listMarkdownFiles,
  slugify,
} from "./docs-links.ts";

describe("extractRelativeLinks", () => {
  it("keeps relative links and skips URLs, mail links and code", () => {
    const md = [
      "[a](docs/A.md) [b](https://example.invalid/x) [c](mailto:x@primjer.invalid)",
      "`[d](nope.md)`",
      "```md",
      "[e](nope2.md)",
      "```",
      "[f](#naslov)",
    ].join("\n");
    expect(extractRelativeLinks(md)).toEqual(["docs/A.md", "#naslov"]);
  });
});

describe("slugify", () => {
  it("lowercases, drops punctuation and dashes spaces", () => {
    expect(slugify("9. `snake_case` u camelCase")).toBe("9-snake_case-u-camelcase");
    expect(slugify("Jedan oblik")).toBe("jedan-oblik");
  });
  it("collects heading slugs outside code blocks", () => {
    expect([...headingSlugs("# Naslov\n```\n# nije\n```\n## Drugi dio")]).toEqual([
      "naslov",
      "drugi-dio",
    ]);
  });
});

describe("findBrokenLinks", () => {
  let dir = "";
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  it("reports missing files and anchors, accepts valid ones", () => {
    dir = mkdtempSync(join(tmpdir(), "docs-links-"));
    mkdirSync(join(dir, "docs"));
    writeFileSync(join(dir, "docs", "B.md"), "# Dio jedan\n");
    const a = join(dir, "A.md");
    writeFileSync(a, "[ok](docs/B.md#dio-jedan) [bad](docs/C.md) [badanchor](docs/B.md#nema)\n");
    expect(findBrokenLinks([a])).toEqual([
      `${a}: docs/C.md (missing file)`,
      `${a}: docs/B.md#nema (missing anchor)`,
    ]);
  });
});

describe("repository documents", () => {
  it("have no broken relative links", () => {
    const root = resolve(import.meta.dirname, "..");
    const files = listMarkdownFiles(root, ["README.md", "docs"]);
    expect(files.length).toBeGreaterThan(0);
    expect(findBrokenLinks(files)).toEqual([]);
  });
});

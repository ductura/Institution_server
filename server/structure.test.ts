import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readAreas } from "./server-map.ts";
import { checkAreaFiles, checkReadmeTemplate, README_HEADINGS } from "./structure.ts";

const ROOT = resolve(import.meta.dirname, "..");
const { areas } = readAreas(readFileSync(join(ROOT, "docs", "server-map.md"), "utf8"));
const EXISTING = areas.filter((a) => a.status === "postoji").map((a) => a.key);

// Areas whose README follows the template. Older READMEs move to it when a
// task changes them (docs/CODE_STYLE.md §10, "Prelazno").
const TEMPLATE_AREAS = [
  "contracts",
  "traffic",
  "metrics",
  "settings",
  "external/email",
  "test-server",
];

const TEMPLATE = README_HEADINGS.map((h) => `${h}\n\nTekst.\n`).join("\n");

describe("area structure in this repo", () => {
  it("reads existing areas from the map", () => {
    expect(EXISTING).toEqual(expect.arrayContaining(TEMPLATE_AREAS));
  });

  it("every existing area has index.ts and README.md", () => {
    expect(EXISTING.flatMap((key) => checkAreaFiles(ROOT, key))).toEqual([]);
  });

  it("template areas have every README heading", () => {
    expect(TEMPLATE_AREAS.flatMap((key) => checkReadmeTemplate(ROOT, key))).toEqual([]);
  });
});

describe("checkAreaFiles and checkReadmeTemplate on a fixture", () => {
  let root = "";
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function fixture(files: Record<string, string>): string {
    root = mkdtempSync(join(tmpdir(), "structure-"));
    const dir = join(root, "server", "invented");
    mkdirSync(dir, { recursive: true });
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
    return root;
  }

  it("accepts a complete area", () => {
    const r = fixture({ "index.ts": "export {};\n", "README.md": TEMPLATE });
    expect(checkAreaFiles(r, "invented")).toEqual([]);
    expect(checkReadmeTemplate(r, "invented")).toEqual([]);
  });

  it("fails an area without README.md", () => {
    const r = fixture({ "index.ts": "export {};\n" });
    expect(checkAreaFiles(r, "invented")).toEqual(["server/invented: missing README.md"]);
  });

  it("fails an area without index.ts", () => {
    const r = fixture({ "README.md": TEMPLATE });
    expect(checkAreaFiles(r, "invented")).toEqual(["server/invented: missing index.ts"]);
  });

  it("fails a missing area folder on both files", () => {
    const r = fixture({});
    expect(checkAreaFiles(r, "absent")).toEqual([
      "server/absent: missing index.ts",
      "server/absent: missing README.md",
    ]);
  });

  it("fails a README without a template heading", () => {
    const r = fixture({
      "index.ts": "export {};\n",
      "README.md": TEMPLATE.replace("## Tko ga zove\n", "## Tko ga poziva\n"),
    });
    expect(checkReadmeTemplate(r, "invented")).toEqual([
      'server/invented/README.md: missing "## Tko ga zove"',
    ]);
  });

  it("does not take a heading of a lower level", () => {
    const r = fixture({
      "index.ts": "export {};\n",
      "README.md": TEMPLATE.replace("## Što izvozi", "### Što izvozi"),
    });
    expect(checkReadmeTemplate(r, "invented")).toEqual([
      'server/invented/README.md: missing "## Što izvozi"',
    ]);
  });
});

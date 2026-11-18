import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseLabels } from "./bot-labels.ts";

const ROOT = resolve(import.meta.dirname, "..", "..");
const VALID = '- { name: "bug", color: "d73a4a", description: "Opis" }\n';

function yamlWith(entry: string): string {
  return `${VALID}- ${entry}\n`;
}

describe("labels.yml: every label has a description and a valid shape", () => {
  it.each([
    ["empty file", ""],
    ["null root", "null\n"],
    ["object root", "name: bug\n"],
    ["scalar root", "bug\n"],
    ["invalid yaml", "- { name: [\n"],
    ["duplicate key", '- { name: "x", name: "y", color: "d73a4a", description: "Opis" }\n'],
    [
      "escaped duplicate key",
      '- { "name": "x", name: "y", color: "d73a4a", description: "Opis" }\n',
    ],
    ["empty list", "[]\n"],
    ["comment only", "# samo komentar\n"],
    ["BOM", `\uFEFF${VALID}`],
    ["two documents", `${VALID}---\n${VALID}`],
    [
      "alias",
      '- { name: "x", color: "d73a4a", description: &d "Opis" }\n- { name: "y", color: "d73a4a", description: *d }\n',
    ],
    [
      "YAML 1.1 directive with a merge key",
      '%YAML 1.1\n---\n- { <<: { description: "Opis", name: "x" }, color: "d73a4a" }\n',
    ],
    ["YAML 1.2 directive", `%YAML 1.2\n---\n${VALID}`],
    ["TAG directive", `%TAG !x! tag:x.invalid,2026:\n---\n${VALID}`],
    ["unknown tag (a warning)", '- { name: "x", color: "d73a4a", description: !foo "Opis" }\n'],
    ["!!merge key", '- { !!merge <<: { description: "Opis" }, name: "x", color: "d73a4a" }\n'],
    ["!!merge key, block", "- !!merge <<:\n    description: Opis\n  name: x\n  color: d73a4a\n"],
    [
      "verbatim merge tag",
      '- { !<tag:yaml.org,2002:merge> <<: { description: "Opis" }, name: "x", color: "d73a4a" }\n',
    ],
    ["!!str tag", '- { name: "x", color: "d73a4a", description: !!str "Opis" }\n'],
    ["%TAG redefining !!", `%TAG !! tag:x.invalid,2026:\n---\n${VALID}`],
    ["%TAG repeating !!", `%TAG !! tag:yaml.org,2002:\n---\n${VALID}`],
  ])("%s is a problem", (_, text) => {
    expect(parseLabels(text).problems).not.toEqual([]);
    expect(parseLabels(text).labels).toEqual([]);
  });

  it.each([
    ["missing description", '{ name: "x", color: "d73a4a" }'],
    ["empty description", '{ name: "x", color: "d73a4a", description: "" }'],
    ["spaces only", '{ name: "x", color: "d73a4a", description: "   " }'],
    ["CGJ only (U+034F, Mn)", '{ name: "x", color: "d73a4a", description: "\\u034f" }'],
    ["Hangul filler only (Lo)", '{ name: "x", color: "d73a4a", description: "\\u3164" }'],
    ["halfwidth filler inside", '{ name: "x", color: "d73a4a", description: "a\\uffa0b" }'],
    ["Hangul choseong filler", '{ name: "x", color: "d73a4a", description: "\\u115fOpis" }'],
    ["NBSP only", '{ name: "x", color: "d73a4a", description: "\\u00a0" }'],
    ["zero width space only", '{ name: "x", color: "d73a4a", description: "\\u200b" }'],
    ["punctuation only", '{ name: "x", color: "d73a4a", description: "..." }'],
    ["bidi mark inside", '{ name: "x", color: "d73a4a", description: "a\\u202eb" }'],
    ["null description", '{ name: "x", color: "d73a4a", description: null }'],
    ["number description", '{ name: "x", color: "d73a4a", description: 5 }'],
    ["101 characters", `{ name: "x", color: "d73a4a", description: "${"a".repeat(101)}" }`],
    ["extra key", '{ name: "x", color: "d73a4a", description: "Opis", default: true }'],
    ["__proto__ key", '{ name: "x", color: "d73a4a", description: "Opis", __proto__: "y" }'],
    ["constructor key", '{ name: "x", color: "d73a4a", description: "Opis", constructor: "y" }'],
    ["merge key", '{ <<: { default: true }, name: "x", color: "d73a4a", description: "Opis" }'],
    [
      "description only from a merge key",
      '{ <<: { description: "Opis" }, name: "x", color: "d73a4a" }',
    ],
    ["scalar entry", '"x"'],
    ["missing name", '{ color: "d73a4a", description: "Opis" }'],
    ["51 characters", `{ name: "${"a".repeat(51)}", color: "d73a4a", description: "Opis" }`],
    ["upper case name", '{ name: "Good-First", color: "d73a4a", description: "Opis" }'],
    ["same name", '{ name: "bug", color: "d73a4a", description: "Opis" }'],
    ["short color", '{ name: "x", color: "d73a4", description: "Opis" }'],
  ])("%s is a problem", (_, entry) => {
    const parsed = parseLabels(yamlWith(entry));
    expect(parsed.problems).not.toEqual([]);
    // The record with a problem is no label; only the valid first one is.
    expect(parsed.labels.map((label) => label.name)).toEqual(["bug"]);
    expect(parseLabels(VALID).problems).toEqual([]);
  });

  it("an inherited description does not count", () => {
    const proto = '- { name: "x", color: "d73a4a", __proto__: { description: "Opis" } }\n';
    expect(parseLabels(proto).problems).not.toEqual([]);
    const plain = '- { name: "x", color: "d73a4a" }\n';
    Object.defineProperty(Object.prototype, "description", { value: "Opis", configurable: true });
    try {
      expect(parseLabels(plain).problems).toEqual(["labels.yml[0]: no description"]);
    } finally {
      Reflect.deleteProperty(Object.prototype, "description");
    }
  });
});

describe("repository", () => {
  it("every label of .github/labels.yml has a description", () => {
    const parsed = parseLabels(readFileSync(join(ROOT, ".github", "labels.yml"), "utf8"));
    expect(parsed.problems).toEqual([]);
    // The exact record: a renamed or dropped label (bug -> kvar) fails here.
    expect(parsed.labels.map((label) => label.name)).toEqual([
      ...["area:auth", "area:ci", "area:db", "area:docs", "area:platforma", "area:sync"],
      ...["area:ui", "bug", "claude:in-progress", "izvjestaj-ceka", "pitanje-za-grok"],
      ...["plan-napada", "ready-for-claude", "risk:critical", "risk:low", "risk:standard"],
      ...["role:backend", "role:frontend", "role:platforma", "security"],
    ]);
  });
});

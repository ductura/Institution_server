// ISTR-6: DOCX files written by other tools (mammoth.js test data, BSD-2-Clause,
// see test-support/docx-zip/mammoth/README.md) go through the same reader as the
// in-memory packages of read-docx.test.ts. Each file has one pinned outcome: an
// import with the exact text, or a closed refusal. The reader is pure, so the
// test also checks that nothing is fetched while reading a file that names an
// external resource.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import { IMPORT_READ_LIMITS } from "../../contracts/index.ts";

import { readDocx } from "./index.ts";

const DIR = new URL("../../../test-support/docx-zip/mammoth/", import.meta.url);
const load = (name: string) => new Uint8Array(readFileSync(new URL(`${name}.docx`, DIR)));
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const PINNED = {
  "strict-format": "86d90f50d8fd3310c4079291c6622878d8f4d8864d665d1e34841f407e7b7662",
  comments: "adc9f524d176f562db830c346c1e9e21c6a6aa6768d9c09892a423f1257fe17c",
  footnotes: "a3d786ba3ad53833dd3d5e01bd55e93b628c1287d8f9210eb94cb7533f270306",
  endnotes: "8b0275a08427605e57e0ca7596bc89fb4c00e4b9a5cdae2b1941c619c2496014",
  tables: "9f75a82d36530d91989a43fcb8940f2e753051787714cecbf6a1f49a22e58ded",
  "external-picture": "2f5dbcf27f3dcec02e81535de21b81a2719e0acfd73158750cb7f91249e628f5",
} as const;

let counter = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;

function textOf(nodes: readonly unknown[]): string[] {
  const out: string[] = [];
  const walk = (node: unknown) => {
    if (typeof node !== "object" || node === null) return;
    const n = node as { type?: string; text?: string; children?: unknown[] };
    if (n.type === "text" && typeof n.text === "string") out.push(n.text);
    n.children?.forEach(walk);
  };
  nodes.forEach(walk);
  return out;
}

function read(name: string) {
  counter = 0;
  return readDocx(load(name), IMPORT_READ_LIMITS, uuid);
}

afterEach(() => vi.restoreAllMocks());

describe("mammoth.js DOCX fixtures (ISTR-6)", () => {
  it("are the files recorded in the README, byte for byte", () => {
    for (const [name, hash] of Object.entries(PINNED)) expect(sha(load(name))).toBe(hash);
  });

  it("strict-format: the Strict OOXML namespaces are refused as an invalid package", () => {
    expect(read("strict-format")).toEqual({ ok: false, code: "PACKAGE_INVALID" });
  });

  it("comments: the body is imported, the comments are only counted, their text is not", () => {
    const result = read("comments");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(textOf(result.content.nodes)).toEqual(["Ouch."]);
    expect(result.traces).toEqual([{ traceKind: "comment", count: 2 }]);
  });

  it.each(["footnotes", "endnotes"])("%s: the body is imported without the note text", (name) => {
    const result = read(name);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(textOf(result.content.nodes)).toEqual(["Ouch."]);
    expect(result.traces).toEqual([]);
    expect(result.contentCanonical).not.toContain("tachyon");
  });

  it("tables: cell text is imported as paragraphs in reading order, no table node", () => {
    const result = read("tables");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(textOf(result.content.nodes)).toEqual([
      "Above",
      "Top left",
      "Top right",
      "Bottom left",
      "Bottom right",
      "Below",
    ]);
    expect(result.content.nodes.every((node) => node.type === "paragraph")).toBe(true);
  });

  it("external-picture: the whole import is refused and nothing is fetched", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(read("external-picture")).toEqual({ ok: false, code: "EXTERNAL_RESOURCE" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("every outcome is the same on a second read of the same bytes", () => {
    for (const name of Object.keys(PINNED)) expect(read(name)).toEqual(read(name));
  });
});

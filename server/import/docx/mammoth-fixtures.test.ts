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
  "strict-format": "1e8b855d57ebfc4210ccb68261be28726a44a480916cdfe5d75e517e87896f78",
  comments: "a94b72df9a354fa1e24a87d540583c47f8d28e5166de13a2d6de4558059e07fd",
  footnotes: "220f80c437b26c5633ad1561ec22421d9d52e1a22da40d935a7d8a170d029565",
  endnotes: "8b0275a08427605e57e0ca7596bc89fb4c00e4b9a5cdae2b1941c619c2496014",
  tables: "87ec522686fb1461d12f8b13a73c9659a6a5c34abb133190f68da8960312c655",
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

describe("mammoth.js DOCX fixtures: no personal data (ISTR-6)", () => {
  it("name only the invented test author in metadata and comments", async () => {
    const { unzipSync, strFromU8 } = await import("fflate");
    for (const name of Object.keys(PINNED)) {
      const files = unzipSync(load(name));
      for (const [part, data] of Object.entries(files)) {
        if (!/\.xml$/u.test(part)) continue;
        expect(strFromU8(data), `${name}:${part}`).not.toMatch(/williamson|chantry/iu);
      }
    }
  });
});

// OSN-B2: properties of the Ductus test docx-reader.property.test.ts (DAN-242)
// against openZip and readXml of this repository. Whatever bytes come in, the
// reader either reads within its limits or refuses with a code of the closed
// set; it never throws and never hands back more than the directory declared.
// The corpus is the synthetic one of tests/fixtures/docx-corpus.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { IMPORT_READ_LIMITS, IMPORT_READ_REJECT_CODES } from "../../contracts/index.ts";

import { readXml } from "./xml.ts";
import { openZip } from "./zip.ts";
import { fixtureZip } from "../../../test-support/docx-zip/index.ts";

const CORPUS_DIR = join(import.meta.dirname, "../../../tests/fixtures/docx-corpus");
const manifest = JSON.parse(readFileSync(join(CORPUS_DIR, "MANIFEST.json"), "utf8")) as {
  fixtures: { file: string }[];
};
const corpus = manifest.fixtures.map((f) => new Uint8Array(readFileSync(join(CORPUS_DIR, f.file))));
const KNOWN = new Set<string>(IMPORT_READ_REJECT_CODES);
const LIMITS = { ...IMPORT_READ_LIMITS, maxEntries: 64, maxXmlDepth: 32 };

function outcome(bytes: Uint8Array): string {
  const opened = openZip(bytes, LIMITS);
  if (!opened.ok) return opened.code;
  for (const [name, entry] of opened.archive.entries) {
    const part = opened.archive.read(name);
    if (!part.ok) return part.code;
    expect(part.bytes.length).toBe(entry.uncompressedSize);
    expect(part.bytes.length).toBeLessThanOrEqual(IMPORT_READ_LIMITS.maxPartBytes);
    const xml = readXml(part.bytes, { maxDepth: 32, maxAttributes: LIMITS.maxXmlAttributes });
    if (!xml.ok) expect(KNOWN.has(xml.code)).toBe(true);
  }
  return "OK";
}

type Mutation = {
  kind: "flip" | "cut" | "splice";
  at: number;
  value?: number;
  bytes?: Uint8Array;
};
const mutation: fc.Arbitrary<Mutation> = fc.oneof(
  fc.record({
    kind: fc.constant("flip" as const),
    at: fc.nat(),
    value: fc.integer({ min: 0, max: 255 }),
  }),
  fc.record({ kind: fc.constant("cut" as const), at: fc.nat() }),
  fc.record({
    kind: fc.constant("splice" as const),
    at: fc.nat(),
    bytes: fc.uint8Array({ maxLength: 40 }),
  }),
);

function mutate(source: Uint8Array, m: Mutation): Uint8Array {
  const at = m.at % (source.length + 1);
  if (m.kind === "cut") return source.slice(0, at);
  if (m.kind === "splice") {
    const out = new Uint8Array(source.length + (m.bytes?.length ?? 0));
    out.set(source.subarray(0, at));
    out.set(m.bytes ?? [], at);
    out.set(source.subarray(at), at + (m.bytes?.length ?? 0));
    return out;
  }
  const out = source.slice();
  if (at < out.length) out[at] = m.value ?? 0;
  return out;
}

/** Independent statement of the path rule from the contract (Z5), written without the reader. */
function pathIsSafe(name: string): boolean {
  if (name.length === 0 || name.startsWith("/")) return false;
  for (let k = 0; k < name.length; k++) {
    const c = name.charCodeAt(k);
    if (c < 0x20 || c === 0x7f || c === 0xfeff || name[k] === "\\" || name[k] === ":") return false;
  }
  const segments = (name.endsWith("/") ? name.slice(0, -1) : name).split("/");
  return segments.every((s) => s !== "" && s !== "." && s !== "..");
}

describe("OSN-B2 reader properties", () => {
  it("a mutated corpus file is read in full or refused with a known code", () => {
    fc.assert(
      fc.property(
        fc.nat({ max: corpus.length - 1 }),
        fc.array(mutation, { minLength: 1, maxLength: 4 }),
        (pick, steps) => {
          const bytes = steps.reduce<Uint8Array>((b, m) => mutate(b, m), corpus[pick]!);
          const code = outcome(bytes);
          expect(code === "OK" || KNOWN.has(code)).toBe(true);
        },
      ),
    );
  });

  it("an entry name is accepted exactly when the independent path rule accepts it", () => {
    const piece = fc.constantFrom(
      "a",
      "word",
      ".",
      "..",
      "",
      "\\",
      ":",
      "\u0000",
      "\u007f",
      "﻿",
      "č",
      "b.xml",
      "C:",
      "%2e",
    );
    fc.assert(
      fc.property(fc.array(piece, { minLength: 1, maxLength: 5 }), fc.boolean(), (pieces, lead) => {
        const name = (lead ? "/" : "") + pieces.join("/");
        const opened = openZip(
          fixtureZip([{ name, data: name.endsWith("/") ? "" : "<a/>" }]),
          IMPORT_READ_LIMITS,
        );
        expect(opened.ok).toBe(pathIsSafe(name));
        if (!opened.ok) expect(opened.code).toBe("ZIP_PATH_INVALID");
      }),
    );
  });

  it("any text is either read or refused with an XML code", () => {
    const token = fc.constantFrom(
      "<a",
      ">",
      "</a>",
      "/>",
      "<b:c",
      ' xmlns:b="urn:b"',
      ' x="1"',
      "&amp;",
      "&#0;",
      "&e;",
      "<!DOCTYPE a>",
      "<?p?>",
      "<!--c-->",
      "<!---->",
      "<![CDATA[x]]>",
      "]]>",
      "\u0001",
      "č",
      " ",
    );
    fc.assert(
      fc.property(
        fc.array(token, { maxLength: 24 }),
        fc.string({ maxLength: 8 }),
        (tokens, tail) => {
          const result = readXml(new TextEncoder().encode(tokens.join("") + tail), {
            maxDepth: 8,
            maxAttributes: 2000,
          });
          expect(result.ok || result.code.startsWith("XML_")).toBe(true);
        },
      ),
    );
  });
});

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { CitationStyle } from "../citation/index.ts";
import { deriveChapters } from "./chapters.ts";
import { contentEqual, documentsEqual } from "./equality.ts";
import { normalizeDocument } from "./normalize.ts";
import type { CanonicalDocumentV3, CanonicalDocumentV4 } from "./schema.ts";
import { textBlocksOf } from "./text-blocks.ts";
import { validateVersionedDocument } from "./validate.ts";
import { documentWordCount } from "./word-count.ts";

// The consumers on document v4 (docs/contracts/document-schema-v4.md §11,
// class 65; SRV-10A), on the golden v4 document with every block, atom and
// mark. Invented data only.

const VECTORS = JSON.parse(
  readFileSync(new URL("./golden-vectors-v4.json", import.meta.url), "utf8"),
) as { documentsV4: { value: CanonicalDocumentV4 }[] };
const EVERY = VECTORS.documentsV4[0]!.value;
const copy = () => structuredClone(EVERY);

const style: CitationStyle = {
  faculty: "izmisljeni",
  style: "author-date",
  version: "1",
  inText: {
    open: "(",
    close: ")",
    authorYearSeparator: ", ",
    pageSeparator: ": ",
    twoAuthorsJoiner: " i ",
    maxNamedAuthors: 2,
    manyAuthorsSuffix: " i sur.",
  },
  bibliography: {
    authorJoiner: " i ",
    periodAfterYear: false,
    editorLabel: "ur.",
    inLabel: "u:",
    accessedLabel: "pristupljeno",
  },
  rangeDash: "–",
};

describe("validateVersionedDocument takes v4 (§10)", () => {
  it("accepts the golden v4 document as found and refuses it as v3", () => {
    expect(validateVersionedDocument(EVERY)).toEqual({ ok: true, doc: EVERY });
    expect(validateVersionedDocument({ ...EVERY, schemaVersion: 3 }).ok).toBe(false);
  });
});

describe("text blocks and word count (§11)", () => {
  it("give the text blocks in order, box paragraphs in place, no table, image or formula", () => {
    const blocks = textBlocksOf(EVERY, { style, orphanMark: "[?]", viaJoiner: ", cit. prema " });
    expect(blocks).toStrictEqual([
      { kind: "heading", text: "Kompostiranje u gradu" },
      {
        kind: "paragraph",
        text: "Prema podacima (Izmišljeni, 1973, cit. prema Izmišljena, 2019: str. 12) udio je x2 in situ vidi zalijepljeno uvezeno",
      },
      { kind: "paragraph", text: "Druga inačica." },
      { kind: "paragraph", text: "def prosjek(xs):\n    return sum(xs) / len(xs)" },
      { kind: "paragraph", text: "Svaki konačan skup je ograničen." },
    ]);
  });

  it("counts body words only: not code, cells, captions or formulas", () => {
    // "Kompostiranje u gradu" 3; the long paragraph 10 ("x" and the
    // superscript "2" are one word, the atoms separate words); "Druga
    // inačica." 2; the box 5. The code block, cells and captions add none.
    expect(documentWordCount(EVERY)).toBe(20);
  });

  it("derives chapters from top-level headings; every top-level block is owned", () => {
    const outline = deriveChapters(EVERY);
    expect(outline.chapters.map((chapter) => chapter.title)).toEqual(["Kompostiranje u gradu"]);
    expect(outline.chapters[0]!.ownBlockIds).toEqual(EVERY.nodes.slice(1).map((node) => node.id));
  });
});

describe("normalize and equality (§11)", () => {
  it("leaves a normalized v4 document byte-equal and joins text with equal marks only", () => {
    expect(normalizeDocument(EVERY)).toStrictEqual(EVERY);
    const doc = copy();
    const lang = (value: string) => [{ lang: value, type: "lang" as const }];
    doc.nodes[2] = {
      type: "paragraph",
      id: doc.nodes[2]!.id,
      children: [
        { type: "text", text: "a", marks: lang("en") },
        { type: "text", text: "b", marks: lang("en") },
        { type: "text", text: "c", marks: lang("de") },
      ],
    };
    expect((normalizeDocument(doc).nodes[2] as { children: unknown[] }).children).toEqual([
      { type: "text", text: "ab", marks: lang("en") },
      { type: "text", text: "c", marks: lang("de") },
    ]);
  });

  it("joins equal marks whatever the order of their attribute keys", () => {
    const doc = copy();
    doc.nodes[2] = {
      type: "paragraph",
      id: doc.nodes[2]!.id,
      children: [
        { type: "text", text: "a", marks: [{ type: "lang", lang: "en" } as never] },
        { type: "text", text: "b", marks: [{ lang: "en", type: "lang" }] },
      ],
    };
    const normalized = normalizeDocument(doc);
    expect((normalized.nodes[2] as { children: unknown[] }).children).toEqual([
      { type: "text", text: "ab", marks: [{ lang: "en", type: "lang" }] },
    ]);
    expect(validateVersionedDocument(normalized).ok).toBe(true);
  });

  it("compares every field: ids, cover, cells, crop and mark attributes", () => {
    expect(documentsEqual(EVERY, copy())).toBe(true);
    expect(contentEqual(EVERY, copy())).toBe(true);
    const changes: ((doc: CanonicalDocumentV4) => void)[] = [
      (doc) => (doc.cover = { place: "Zagreb" }),
      (doc) => ((doc.nodes[3] as { rows: string[][] }).rows[1]![2] = "x"),
      (doc) => ((doc.nodes[4] as { crop?: unknown }).crop = undefined),
      (doc) =>
        ((doc.nodes[1] as { children: { marks?: unknown[] }[] }).children[5]!.marks = [
          { lang: "it", type: "lang" },
        ]),
      (doc) => ((doc.nodes[7] as { kind: string }).kind = "lemma"),
    ];
    for (const change of changes) {
      const other = copy();
      change(other);
      expect(documentsEqual(EVERY, other)).toBe(false);
      expect(contentEqual(EVERY, other)).toBe(false);
    }
    const renamed = copy();
    (renamed.nodes[7] as { children: { id: string }[] }).children[0]!.id =
      "0aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    expect(documentsEqual(EVERY, renamed)).toBe(false);
    expect(contentEqual(EVERY, renamed)).toBe(true);
  });

  it("never finds a v4 document equal to a v3 one", () => {
    const v3: CanonicalDocumentV3 = {
      schemaVersion: 3,
      sources: [],
      nodes: [{ type: "paragraph", id: EVERY.nodes[1]!.id, children: [] }],
    };
    const v4: CanonicalDocumentV4 = { ...v3, schemaVersion: 4 };
    expect(documentsEqual(v3, v4)).toBe(false);
    expect(contentEqual(v4, v3)).toBe(false);
  });
});

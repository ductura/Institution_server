import { describe, expect, it } from "vitest";

import type { CitationStyle } from "../citation/index.ts";
import {
  bulletItemNode,
  headingNode,
  paragraphNode,
  textNode,
  type CanonicalDocumentV3,
  type NodeId,
  type SourceId,
} from "./schema.ts";
import { textBlocksOf } from "./text-blocks.ts";

const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}` as NodeId;

describe("textBlocksOf (B-11c, #757)", () => {
  it("gives each node as a block in document order, marks dropped and runs joined", () => {
    const blocks = textBlocksOf({
      schemaVersion: 1,
      nodes: [
        headingNode(id(1), 2, [textNode("Uvod")]),
        paragraphNode(id(2), [
          textNode("Lorem "),
          textNode("ipsum", ["bold", "italic"]),
          textNode(" dolor."),
        ]),
        paragraphNode(id(3)),
      ],
    });
    expect(blocks).toStrictEqual([
      { kind: "heading", text: "Uvod" },
      { kind: "paragraph", text: "Lorem ipsum dolor." },
      { kind: "paragraph", text: "" },
    ]);
  });

  it("gives a bullet list item as a paragraph, the only other kind of the contract", () => {
    const blocks = textBlocksOf({
      schemaVersion: 1,
      nodes: [
        paragraphNode(id(1), [textNode("Popis:")]),
        bulletItemNode(id(2), [textNode("prva "), textNode("stavka", ["bold"])]),
        bulletItemNode(id(3)),
      ],
    });
    expect(blocks).toStrictEqual([
      { kind: "paragraph", text: "Popis:" },
      { kind: "paragraph", text: "prva stavka" },
      { kind: "paragraph", text: "" },
    ]);
  });

  it("gives no blocks for an empty document", () => {
    expect(textBlocksOf({ schemaVersion: 1, nodes: [] })).toStrictEqual([]);
  });
});

describe("textBlocksOf on document v3 (contract document-schema-v3 §8)", () => {
  // An invented author-date style with the in-text punctuation of FPZG.
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
  const S = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as SourceId;
  const doc: CanonicalDocumentV3 = {
    schemaVersion: 3,
    sources: [
      {
        id: S,
        type: "book",
        authors: [{ kind: "person", family: "Izmišljena", given: "Ana" }],
        year: 2019,
        title: "Izvor 1",
        place: "Zagreb",
        publisher: "Izmišljena naklada",
      },
    ],
    nodes: [
      headingNode(id(1), 2, [textNode("Uvod")]),
      {
        type: "paragraph",
        id: id(2),
        children: [
          textNode("Tvrdnja "),
          { type: "citation", sourceId: S, locator: "14", via: "Izmišljeni, 1973" },
          { type: "footnote", text: "Ne ide u tekst bloka." },
          textNode(" i "),
          { type: "citation", sourceId: S },
          { type: "crossReference", targetId: id(1) },
          textNode("."),
          {
            type: "citation",
            sourceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" as SourceId,
            via: "Drugi, 1950",
          },
        ],
      },
    ],
  };

  it("shows a citation with via in front, inside the bracket; footnote and reference add nothing", () => {
    const blocks = textBlocksOf(doc, { style, orphanMark: "[?]", viaJoiner: ", cit. prema " });
    expect(blocks).toStrictEqual([
      { kind: "heading", text: "Uvod" },
      {
        kind: "paragraph",
        text: "Tvrdnja (Izmišljeni, 1973, cit. prema Izmišljena, 2019: 14) i (Izmišljena, 2019).Drugi, 1950, cit. prema [?]",
      },
    ]);
  });

  it("gives the body text alone without a rendering, never the text of a footnote", () => {
    expect(textBlocksOf(doc as never)[1]!.text).toBe("Tvrdnja  i .");
  });
});

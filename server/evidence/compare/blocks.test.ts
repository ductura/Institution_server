// SRV-9E: the blocks of a reconstructed document and their difference.
// Synthetic only: invented ids and filler text.
import { describe, expect, it } from "vitest";

import { blocksOf, type CompareBlock, diffBlocks } from "./blocks.ts";

const ID = "aaaaaaaa-0000-4000-8000-000000000001";
const text = (value: string) => ({ type: "text", text: value, marks: [] });
const doc = (nodes: unknown[]) => JSON.stringify({ schemaVersion: 1, nodes });
const p = (value: string): CompareBlock => ({ kind: "paragraph", text: value });

describe("blocksOf", () => {
  it("reads every block kind in order, text children joined", () => {
    expect(
      blocksOf(
        doc([
          { type: "heading", id: ID, level: 2, children: [text("Naslov")] },
          { type: "paragraph", id: ID, children: [text("Odlomak "), text("lorem.")] },
          { type: "bulletItem", id: ID, children: [text("Stavka")] },
          { type: "quote", id: ID, children: [] },
        ]),
      ),
    ).toStrictEqual([
      { kind: "heading", level: 2, text: "Naslov" },
      { kind: "paragraph", text: "Odlomak lorem." },
      { kind: "bulletItem", text: "Stavka" },
      { kind: "quote", text: "" },
    ]);
  });

  it("reads a numbered list item (v4 orderedItem) as a paragraph with its text", () => {
    expect(
      blocksOf(
        doc([
          { type: "orderedItem", id: ID, children: [text("Prva "), text("stavka")] },
          { type: "orderedItem", id: ID, children: [] },
          { type: "bulletItem", id: ID, children: [text("Natuknica")] },
        ]),
      ),
    ).toStrictEqual([p("Prva stavka"), p(""), { kind: "bulletItem", text: "Natuknica" }]);
  });

  it("still refuses a numbered list item whose children are not inline nodes", () => {
    expect(blocksOf(doc([{ type: "orderedItem", id: ID }]))).toBeNull();
    expect(blocksOf(doc([{ type: "orderedItem", id: ID, children: ["x"] }]))).toBeNull();
  });

  it("adds no character for an inline node that is not text", () => {
    expect(
      blocksOf(
        doc([
          {
            type: "paragraph",
            id: ID,
            children: [text("Prije"), { type: "citation", sourceId: ID }, text(" poslije")],
          },
        ]),
      ),
    ).toStrictEqual([p("Prije poslije")]);
  });

  it.each([
    ["not JSON", "{"],
    ["no nodes", JSON.stringify({ schemaVersion: 1 })],
    ["an unknown block", doc([{ type: "table", id: ID, children: [] }])],
    ["a block without children", doc([{ type: "paragraph", id: ID }])],
    ["a heading without a level", doc([{ type: "heading", id: ID, children: [] }])],
    [
      "a text without its string",
      doc([{ type: "paragraph", id: ID, children: [{ type: "text" }] }]),
    ],
  ])("refuses %s", (_, canonical) => {
    expect(blocksOf(canonical)).toBeNull();
  });
});

describe("diffBlocks on numbered list items", () => {
  const items = (...values: string[]) =>
    blocksOf(doc(values.map((v) => ({ type: "orderedItem", id: ID, children: [text(v)] }))))!;

  it("shows a changed, inserted and removed item of a numbered list", () => {
    expect(diffBlocks(items("A", "B", "C"), items("A", "X", "C", "D"))).toStrictEqual([
      { ...p("A"), change: "unchanged" },
      { ...p("B"), change: "removed" },
      { ...p("X"), change: "added" },
      { ...p("C"), change: "unchanged" },
      { ...p("D"), change: "added" },
    ]);
  });
});

describe("diffBlocks", () => {
  it("keeps equal versions unchanged", () => {
    expect(diffBlocks([p("A"), p("B")], [p("A"), p("B")])).toStrictEqual([
      { ...p("A"), change: "unchanged" },
      { ...p("B"), change: "unchanged" },
    ]);
  });

  it("places a removed block before the added one at the same place", () => {
    expect(diffBlocks([p("A"), p("B"), p("C")], [p("A"), p("X"), p("C"), p("D")])).toStrictEqual([
      { ...p("A"), change: "unchanged" },
      { ...p("B"), change: "removed" },
      { ...p("X"), change: "added" },
      { ...p("C"), change: "unchanged" },
      { ...p("D"), change: "added" },
    ]);
  });

  it("keeps the longest common run of a moved middle", () => {
    const result = diffBlocks([p("A"), p("B"), p("C"), p("D")], [p("C"), p("D"), p("A")]);
    expect(result.filter((e) => e.change === "unchanged").map((e) => e.text)).toStrictEqual([
      "C",
      "D",
    ]);
  });

  it("counts a change of kind or heading level as a change", () => {
    const h1: CompareBlock = { kind: "heading", level: 1, text: "A" };
    const h2: CompareBlock = { kind: "heading", level: 2, text: "A" };
    expect(diffBlocks([h1, p("A")], [h2, { kind: "quote", text: "A" }])).toStrictEqual([
      { ...h1, change: "removed" },
      { ...p("A"), change: "removed" },
      { ...h2, change: "added" },
      { kind: "quote", text: "A", change: "added" },
    ]);
  });

  it("replaces a middle whose table is over the cell limit whole, keeping start and end", () => {
    const before = [p("A"), p("B"), p("C"), p("Z")];
    const after = [p("A"), p("C"), p("B"), p("Z")];
    expect(diffBlocks(before, after, 8)).toStrictEqual([
      { ...p("A"), change: "unchanged" },
      { ...p("B"), change: "removed" },
      { ...p("C"), change: "removed" },
      { ...p("C"), change: "added" },
      { ...p("B"), change: "added" },
      { ...p("Z"), change: "unchanged" },
    ]);
  });
});

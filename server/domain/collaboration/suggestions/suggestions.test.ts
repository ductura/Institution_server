import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createTextAnchor, type TextAnchor } from "../index.ts";
import { newNodeId, verifyDocumentSnapshot, type CanonicalDocument } from "../../document/index.ts";
import { canonicalizeJcs } from "../../forensics/index.ts";

import {
  applySuggestion,
  attributeChange,
  isSuggestionInput,
  nextState,
  SUGGESTION_STATES,
  SUGGESTION_TEXT_MAX,
  type Suggestion,
} from "./index.ts";

// Invented text and ids only.
const P1 = newNodeId(() => "11111111-1111-4111-8111-111111111111");
const P2 = newNodeId(() => "22222222-2222-4222-8222-222222222222");
const WORK = "rad-izmisljeni-1";
const SUGGESTION_ID = "33333333-3333-4333-8333-333333333333";
const FIRST = "Izmišljeni grad ima tri trga i jednu rijeku.";

function work(): CanonicalDocument {
  return {
    schemaVersion: 1,
    nodes: [
      {
        type: "paragraph",
        id: P1,
        children: [
          { type: "text", text: "Izmišljeni grad ima ", marks: [] },
          { type: "text", text: "tri trga", marks: ["bold"] },
          { type: "text", text: " i jednu rijeku.", marks: [] },
        ],
      },
      {
        type: "paragraph",
        id: P2,
        children: [{ type: "text", text: "Drugi odlomak.", marks: [] }],
      },
    ],
  };
}

const anchorOf = (quote: string, text = FIRST): TextAnchor => {
  const start = text.indexOf(quote);
  return createTextAnchor({ nodeId: P1, nodeText: text, start, end: start + quote.length });
};
const suggestion = (quote: string, text: string, state = "pending" as const): Suggestion => ({
  suggestionId: SUGGESTION_ID,
  documentId: WORK,
  anchor: anchorOf(quote),
  text,
  state,
});
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

describe("isSuggestionInput", () => {
  const anchor = anchorOf("jednu rijeku");
  it.each([
    ["a replacement", { anchor, text: "dvije rijeke" }, true],
    ["a removal", { anchor, text: "" }, true],
    ["the longest text", { anchor, text: "a".repeat(SUGGESTION_TEXT_MAX) }, true],
    ["the quote unchanged", { anchor, text: "jednu rijeku" }, false],
    ["an unknown field", { anchor, text: "x", author: "nastavnik" }, false],
    ["a missing text", { anchor }, false],
    ["a text that is not a string", { anchor, text: 7 }, false],
    ["a null byte", { anchor, text: "a\u0000b" }, false],
    ["a line break", { anchor, text: "a\nb" }, false],
    ["a bidi override", { anchor, text: "a\u202Eb" }, false],
    ["a lone surrogate", { anchor, text: "a\uD800b" }, false],
    ["a text not in NFC", { anchor, text: "e\u0301" }, false],
    ["a text too long", { anchor, text: "a".repeat(SUGGESTION_TEXT_MAX + 1) }, false],
    ["an anchor with a field more", { anchor: { ...anchor, extra: 1 }, text: "x" }, false],
    ["an array", [anchor, "x"], false],
  ])("%s", (_name, input, expected) => {
    expect(isSuggestionInput(input)).toBe(expected);
  });
});

describe("nextState", () => {
  it("moves only a pending suggestion, once, for every (state, action) pair", () => {
    const table = SUGGESTION_STATES.flatMap((state) =>
      (["accept", "reject"] as const).map((action) => [state, action, nextState(state, action)]),
    );
    expect(table).toEqual([
      ["pending", "accept", "accepted"],
      ["pending", "reject", "rejected"],
      ["accepted", "accept", null],
      ["accepted", "reject", null],
      ["rejected", "accept", null],
      ["rejected", "reject", null],
    ]);
  });
});

describe("applySuggestion", () => {
  it("leaves the document it is given and its hash unchanged", () => {
    const document = work();
    const before = canonicalizeJcs(document);
    applySuggestion(document, suggestion("tri trga i jednu", "četiri trga i dvije"));
    expect(canonicalizeJcs(document)).toBe(before);
    expect(sha256(canonicalizeJcs(document))).toBe(sha256(before));
  });

  it("gives the accepted text, the bytes live.document.put takes, and the recorded change", async () => {
    const applied = applySuggestion(work(), suggestion("tri trga i jednu", "četiri trga i dvije"));
    if (!applied.ok) throw new Error(applied.reason);
    expect(applied.document.nodes[0]!.children).toEqual([
      { type: "text", text: "Izmišljeni grad ima ", marks: [] },
      { type: "text", text: "četiri trga i dvije", marks: ["bold"] },
      { type: "text", text: " rijeku.", marks: [] },
    ]);
    expect(applied.document.nodes[1]).toEqual(work().nodes[1]);
    expect(applied.change).toEqual({
      source: "teacher-suggestion",
      suggestionId: SUGGESTION_ID,
      nodeId: P1,
      start: 20,
      end: 36,
      removed: "tri trga i jednu",
      inserted: "četiri trga i dvije",
    });
    const live = await verifyDocumentSnapshot(new TextEncoder().encode(applied.text));
    expect(live.ok && live.sha256).toBe(sha256(applied.text));
    expect(applied.text).not.toBe(canonicalizeJcs(work()));
  });

  it("removes the quote and merges the neighbours", () => {
    const applied = applySuggestion(work(), suggestion("tri trga", ""));
    if (!applied.ok) throw new Error(applied.reason);
    expect(applied.document.nodes[0]!.children).toEqual([
      { type: "text", text: "Izmišljeni grad ima  i jednu rijeku.", marks: [] },
    ]);
  });

  it.each([
    ["accepted", { state: "accepted" }, "not_pending"],
    ["rejected", { state: "rejected" }, "not_pending"],
    [
      "a node that is not there",
      { anchor: { ...anchorOf("tri"), nodeId: newNodeId() } },
      "missing",
    ],
    ["a quote that is gone", { anchor: { ...anchorOf("tri"), quote: "pet" } }, "missing"],
  ])("refuses %s", (_name, change, reason) => {
    const refused = applySuggestion(work(), { ...suggestion("tri", "x"), ...change } as Suggestion);
    expect(refused).toEqual({ ok: false, reason });
  });

  it("refuses a quote with no single place", () => {
    const text = "ab ab";
    const document: CanonicalDocument = {
      schemaVersion: 1,
      nodes: [{ type: "paragraph", id: P1, children: [{ type: "text", text, marks: [] }] }],
    };
    const anchor = { nodeId: P1, quote: "ab", prefix: "", suffix: "", startHint: 9, endHint: 11 };
    expect(applySuggestion(document, { ...suggestion("tri", "x"), anchor })).toEqual({
      ok: false,
      reason: "ambiguous",
    });
  });

  it("refuses a result above the 2 MiB of a live state", () => {
    const long = "X" + "a".repeat(1024 * 1024 - 1001);
    const paragraph = (id: typeof P1) => ({
      type: "paragraph" as const,
      id,
      children: [{ type: "text" as const, text: long, marks: [] }],
    });
    const document: CanonicalDocument = { schemaVersion: 1, nodes: [paragraph(P1), paragraph(P2)] };
    expect(new TextEncoder().encode(canonicalizeJcs(document)).byteLength).toBeLessThan(
      2 * 1024 * 1024,
    );
    const anchor = createTextAnchor({ nodeId: P1, nodeText: long, start: 0, end: 1 });
    const big = { ...suggestion("tri", "x"), anchor, text: "ž".repeat(SUGGESTION_TEXT_MAX) };
    expect(applySuggestion(document, big)).toEqual({ ok: false, reason: "too_large" });
  });
});

describe("attributeChange", () => {
  const stored = suggestion("jednu rijeku", "dvije rijeke");
  const accepted = () => {
    const applied = applySuggestion(work(), stored);
    if (!applied.ok) throw new Error(applied.reason);
    return applied;
  };

  it("records the teacher's suggestion only for its exact result", () => {
    expect(attributeChange(WORK, work(), accepted().document, stored)).toEqual({
      source: "teacher-suggestion",
      change: accepted().change,
    });
  });

  it("gives the student any other change, whatever the client says", () => {
    const edited = structuredClone(accepted().document);
    edited.nodes[1]!.children[0]!.text = "Drugi odlomak, malo drukčiji.";
    expect(attributeChange(WORK, work(), edited, stored)).toEqual({ source: "student" });
    expect(attributeChange("rad-izmisljeni-2", work(), accepted().document, stored)).toEqual({
      source: "student",
    });
    expect(
      attributeChange(WORK, work(), accepted().document, { ...stored, state: "accepted" }),
    ).toEqual({ source: "student" });
  });
});

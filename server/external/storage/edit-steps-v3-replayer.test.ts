// @vitest-environment node
import { Transform } from "@tiptap/pm/transform";
import { describe, expect, it } from "vitest";

import {
  canonicalizeJcs,
  REVISION_ZERO_V3_JCS,
  type EvidenceEventV3,
  type JcsJsonValue,
} from "../../domain/index.ts";

import { createEditStepsV2Replayer, createEditStepsV3Replayer } from "./edit-steps-v2-replayer.ts";
import { createBrowserEditStepsV3Replayer } from "./edit-steps-v2-browser-replayer.ts";
import { removedRangeSha256 } from "./edit-steps-v1-replayer.ts";
import {
  editStepJsonV3,
  editStepsV3Schema,
  type EditStepsV2Document,
} from "./edit-steps-v2-rules.ts";

/**
 * Replay of `ductus-edit-steps-v3`, docs/contracts/document-schema-v3.md §5
 * and §10 classes 41, 42 and 44 (SRV-7A). Synthetic only: invented ids,
 * filler text and an invented source record.
 */

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "aaaaaaaa-0000-4000-8000-000000000002";
const S1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RQ = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OTHER_HASH = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";

const text = (value: string) => ({ type: "text", text: value, marks: [] });

// Heading B 0..8 ("Uvod" 1..5 is 4 long: 0..6); paragraph A after it.
const start = {
  schemaVersion: 3,
  nodes: [
    { type: "heading", id: B, level: 1, children: [text("Uvod")] },
    {
      type: "paragraph",
      id: A,
      children: [
        text("Prije "),
        { type: "citation", sourceId: S1, locator: "str. 12", via: "Izmišljeni, 1973" },
        { type: "footnote", text: "Objašnjenje." },
        { type: "crossReference", targetId: B },
        text(" poslije."),
      ],
    },
  ],
  sources: [],
} as unknown as JcsJsonValue;

const replayer = createEditStepsV3Replayer();
const schema = editStepsV3Schema();
const state = replayer.load(start);
// "Uvod" heading spans 0..6; paragraph opens at 6, "Prije " is 7..13,
// the citation 13, the footnote 14, the cross reference 15.
const [CITE, NOTE, REF] = [13, 14, 15];

const event = (steps: unknown[]): EvidenceEventV3 =>
  ({
    sequence: 1,
    source: "editor",
    steps,
    beforeDocumentHash: OTHER_HASH,
    afterDocumentHash: OTHER_HASH,
  }) as unknown as EvidenceEventV3;

/** What capture does: ProseMirror's steps in v3 step form, plus the hash of each removed range. */
function capture(edit: (tr: Transform) => void, from: EditStepsV2Document = state) {
  const tr = new Transform(from.doc);
  edit(tr);
  const steps = tr.steps.map((step, i) => {
    const json = editStepJsonV3(step.toJSON()) as Record<string, unknown>;
    const [a, b] = [json.from as number, json.to as number];
    if (json.stepType === "replace" && b > a && !json.structure) {
      json.removedSha256 = removedRangeSha256(tr.docs[i]!, a, b);
    }
    return JSON.parse(JSON.stringify(json)) as unknown;
  });
  return { steps, after: tr.doc };
}

const apply = (steps: unknown[], from: EditStepsV2Document = state) =>
  replayer.apply(from, event(steps));
const canonical = (document: EditStepsV2Document) =>
  canonicalizeJcs(replayer.toCanonical(document));
const paragraph = (document: EditStepsV2Document) =>
  (replayer.toCanonical(document) as { nodes: { children: unknown[] }[] }).nodes[1]!.children;

describe("load and toCanonical of the v3 replayer", () => {
  it("round-trips a v3 document with every atom, byte-equal", () => {
    expect(canonical(state)).toBe(canonicalizeJcs(start));
    expect(state.doc.nodeAt(CITE)!.type.name).toBe("citation");
    expect(state.doc.nodeAt(NOTE)!.type.name).toBe("footnote");
    expect(state.doc.nodeAt(REF)!.type.name).toBe("crossReference");
  });

  it("loads the v3 revision 0 and refuses a document of any other version (class 44)", () => {
    expect(
      canonicalizeJcs(replayer.toCanonical(replayer.load(JSON.parse(REVISION_ZERO_V3_JCS)))),
    ).toBe(REVISION_ZERO_V3_JCS);
    const asV2 = { ...(start as object), schemaVersion: 2 } as JcsJsonValue;
    expect(() => replayer.load(asV2)).toThrow();
    expect(() => createEditStepsV2Replayer().load(start)).toThrow();
  });
});

describe("steps over atoms (classes 41 and 42)", () => {
  it("inserts every atom, as the editor writes it", () => {
    const { steps, after } = capture((tr) =>
      tr.insert(7, [
        schema.nodes.footnote!.create({ text: "Druga fusnota." }),
        schema.nodes.crossReference!.create({ targetId: B }),
        schema.nodes.citation!.create({ sourceId: S1, rq: RQ }),
      ]),
    );
    expect(JSON.stringify(steps)).toContain('"type":"footnote"');
    const next = apply(steps);
    expect(next.doc.eq(after)).toBe(true);
    expect(paragraph(next).slice(0, 3)).toEqual([
      { type: "footnote", text: "Druga fusnota." },
      { type: "crossReference", targetId: B },
      { type: "citation", sourceId: S1, rq: RQ },
    ]);
  });

  it("removes a footnote and a cross reference only with the hash of what goes", () => {
    const { steps } = capture((tr) => tr.delete(NOTE, REF + 1));
    expect(paragraph(apply(steps)).map((child) => (child as { type: string }).type)).toEqual([
      "text",
      "citation",
      "text",
    ]);
    const step = steps[0] as Record<string, unknown>;
    const bare = { ...step };
    delete bare.removedSha256;
    expect(() => apply([bare])).toThrow();
    expect(() => apply([{ ...step, removedSha256: OTHER_HASH }])).toThrow();
    // The hash of the same range with another footnote text does not fit.
    const other = capture((tr) => tr.setNodeMarkup(NOTE, null, { text: "Drugo." })).after;
    const wrong = removedRangeSha256(other, NOTE, REF + 1);
    expect(() => apply([{ ...step, removedSha256: wrong }])).toThrow();
  });

  it.each([
    ["footnote text", NOTE, { text: "Drugo objašnjenje." }],
    ["via", CITE, { sourceId: S1, locator: "str. 12", via: "Druga, 1980", rq: null }],
    ["rq set", CITE, { sourceId: S1, locator: "str. 12", via: "Izmišljeni, 1973", rq: RQ }],
    ["target", REF, { targetId: A }],
  ])("a change of %s is a replace with the hash of the old atom", (_, pos, attrs) => {
    const { steps, after } = capture((tr) => tr.setNodeMarkup(pos, null, attrs));
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      stepType: "replace",
      from: pos,
      to: pos + 1,
      removedSha256: removedRangeSha256(state.doc, pos, pos + 1),
    });
    expect(apply(steps).doc.eq(after)).toBe(true);
  });

  it("a mark over the atoms leaves every atom unmarked", () => {
    const { steps } = capture((tr) => tr.addMark(7, 19, schema.marks.bold!.create()));
    const next = apply(steps);
    next.doc.descendants((node) => {
      if (node.isInline && node.isLeaf && !node.isText) expect(node.marks).toEqual([]);
    });
  });
});

describe("the browser driver replays v3 the same way", () => {
  it("gives the same document for the same steps", async () => {
    const browser = createBrowserEditStepsV3Replayer();
    const { steps } = capture((tr) => tr.setNodeMarkup(NOTE, null, { text: "Treće." }));
    const loaded = browser.load(start);
    const next = await browser.apply(loaded, event(steps));
    expect(canonicalizeJcs(browser.toCanonical(next))).toBe(canonical(apply(steps)));
  });
});

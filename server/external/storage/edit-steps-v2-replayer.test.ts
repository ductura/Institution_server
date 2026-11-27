// @vitest-environment node
import { createHash } from "node:crypto";

import { Transform } from "@tiptap/pm/transform";
import { describe, expect, it } from "vitest";

import type { DocumentSource } from "../../domain/document/schema.ts";
import {
  digestCanonicalDocumentV2,
  replayEvidenceSegmentsV2,
} from "../../domain/forensics/evidence-replay-v2.ts";
import type {
  EvidenceEventV3,
  EvidenceSegmentV2,
} from "../../domain/forensics/evidence-segment-v2.ts";
import { canonicalizeJcs, type JcsJsonValue } from "../../domain/forensics/jcs.ts";

import { createEditStepsV1Replayer, removedRangeSha256 } from "./edit-steps-v1-replayer.ts";
import { removedRangeCanonical } from "./edit-steps-v1-rules.ts";
import {
  createEditStepsV1OnV2Replayer,
  createEditStepsV2Replayer,
  sourceRecordSha256,
} from "./edit-steps-v2-replayer.ts";
import {
  editStepJsonV2,
  runEditSteps,
  editStepsV2Schema,
  type EditStepsV2Document,
} from "./edit-steps-v2-rules.ts";

/**
 * Replay of `ductus-edit-steps-v2`, docs/contracts/document-schema-v2.md §5
 * and §10 classes 25 to 28 (DAN-619 PR b). Synthetic only: invented ids,
 * filler text and invented source records.
 */

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "aaaaaaaa-0000-4000-8000-000000000002";
const C = "aaaaaaaa-0000-4000-8000-000000000003";
const S1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const S2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const S3 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OTHER_HASH = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";

const text = (value: string) => ({ type: "text", text: value, marks: [] });
const book = (id: string, over: object = {}) =>
  ({
    id,
    authors: [{ kind: "person", family: "Prezime", given: "Ime" }],
    year: 2020,
    title: "Izvor 1",
    type: "book",
    place: "Zagreb",
    publisher: "Nakladnik",
    ...over,
  }) as unknown as DocumentSource;

// Paragraph A: "Prije " 1..7, the citation 7..8, " poslije." 8..17; heading B 18..26 ("Naslov" 19..25).
const start: JcsJsonValue = {
  schemaVersion: 2,
  nodes: [
    {
      type: "paragraph",
      id: A,
      children: [
        text("Prije "),
        { type: "citation", sourceId: S1, locator: "str. 12" },
        text(" poslije."),
      ],
    },
    { type: "heading", id: B, level: 2, children: [text("Naslov")] },
    { type: "paragraph", id: C, children: [text("Treći odlomak.")] },
  ],
  sources: [book(S1), book(S2, { title: "Izvor 2" })],
} as unknown as JcsJsonValue;

const replayer = createEditStepsV2Replayer();
const schema = editStepsV2Schema();
const state = replayer.load(start);
const doc = state.doc;

const event = (steps: unknown[], sequence = 1): EvidenceEventV3 =>
  ({
    sequence,
    source: "editor",
    steps,
    beforeDocumentHash: OTHER_HASH,
    afterDocumentHash: OTHER_HASH,
  }) as unknown as EvidenceEventV3;

/** What capture does: ProseMirror's steps in step form (§5.1), plus the hash of each removed range. */
function capture(edit: (tr: Transform) => void, from: EditStepsV2Document = state) {
  const tr = new Transform(from.doc);
  edit(tr);
  const steps = tr.steps.map((step, i) => {
    const json = editStepJsonV2(step.toJSON()) as Record<string, unknown>;
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
const refused = (steps: unknown[], from: EditStepsV2Document = state) =>
  expect(() => apply(steps, from));
const citations = (document: EditStepsV2Document) => {
  const found: unknown[] = [];
  document.doc.descendants((node) => {
    if (node.type.name === "citation") found.push({ ...node.attrs, marks: node.marks.length });
  });
  return found;
};

describe("removing a citation (§5.2, class 25)", () => {
  it("pins the hashed form of a removed citation", () => {
    const json = `{"content":[{"attrs":{"locator":"str. 12","sourceId":"${S1}"},"type":"citation"}]}`;
    expect(removedRangeCanonical(doc, 7, 8)).toBe(json);
    expect(removedRangeSha256(doc, 7, 8)).toBe(
      createHash("sha256").update(json, "utf8").digest("hex"),
    );
  });

  it("removes it with the hash of the removed range", () => {
    const { steps, after } = capture((tr) => tr.delete(7, 8));
    expect(steps).toEqual([
      { stepType: "replace", from: 7, to: 8, removedSha256: removedRangeSha256(doc, 7, 8) },
    ]);
    expect(apply(steps).doc.toJSON()).toEqual(after.toJSON());
    expect(citations(apply(steps))).toEqual([]);
  });

  it("refuses it without a hash, with another hash or with the hash of another locator", () => {
    refused([{ stepType: "replace", from: 7, to: 8 }]).toThrow("missing_field");
    refused([{ stepType: "replace", from: 7, to: 8, removedSha256: OTHER_HASH }]).toThrow(
      "removed_range_hash",
    );
    const other = createHash("sha256")
      .update(
        `{"content":[{"attrs":{"locator":"str. 13","sourceId":"${S1}"},"type":"citation"}]}`,
        "utf8",
      )
      .digest("hex");
    refused([{ stepType: "replace", from: 7, to: 8, removedSha256: other }]).toThrow(
      "removed_range_hash",
    );
  });

  it("needs the hash for a range that holds the citation among text", () => {
    const { steps, after } = capture((tr) => tr.delete(5, 10));
    expect(apply(steps).doc.toJSON()).toEqual(after.toJSON());
    refused([{ ...(steps[0] as object), removedSha256: removedRangeSha256(doc, 5, 9) }]).toThrow(
      "removed_range_hash",
    );
    refused([{ stepType: "replace", from: 6, to: 8, structure: true }]).toThrow(
      "removed_range_record",
    );
  });

  it("replaces a citation with another only with the hash of the old one", () => {
    const { steps, after } = capture((tr) =>
      tr.replaceWith(7, 8, schema.nodes.citation!.create({ sourceId: S2, locator: null })),
    );
    expect(steps).toEqual([
      {
        stepType: "replace",
        from: 7,
        to: 8,
        removedSha256: removedRangeSha256(doc, 7, 8),
        slice: { content: [{ sourceId: S2, type: "citation" }] },
      },
    ]);
    expect(apply(steps).doc.toJSON()).toEqual(after.toJSON());
    refused([{ ...(steps[0] as object), removedSha256: OTHER_HASH }]).toThrow("removed_range_hash");
  });
});

describe("structure and headings around a citation (§3.1, class 26)", () => {
  it("refuses structure over a citation", () => {
    refused([{ stepType: "replace", from: 7, to: 9, structure: true }]).toThrow(
      "removed_range_record",
    );
    refused([{ stepType: "replace", from: 7, to: 8, structure: true }]).toThrow("not_canonical");
  });

  it("refuses to turn a paragraph with a citation into a heading", () => {
    const toHeading = (pos: number, end: number, nodeId: string) => ({
      stepType: "replaceAround",
      from: pos,
      to: end,
      gapFrom: pos + 1,
      gapTo: end - 1,
      insert: 1,
      structure: true,
      slice: { content: [{ type: "heading", attrs: { level: 2, nodeId } }] },
    });
    refused([toHeading(0, 18, A)]).toThrow("step_does_not_apply");
    // The same step on paragraph C, which holds no citation, goes through.
    const { steps } = capture((tr) =>
      tr.setBlockType(27, 27, schema.nodes.heading!, { level: 2, nodeId: C }),
    );
    expect(steps).toEqual([toHeading(26, 42, C)]);
    expect(replayer.toCanonical(apply(steps))).toMatchObject({
      nodes: [{}, {}, { type: "heading", id: C }],
    });
  });

  it("refuses a citation inserted into a heading", () => {
    refused([
      {
        stepType: "replace",
        from: 20,
        to: 20,
        slice: { content: [{ type: "citation", sourceId: S1 }] },
      },
    ]).toThrow("step_does_not_apply");
  });

  it("keeps a citation unmarked when a mark covers it", () => {
    const { steps } = capture((tr) => tr.addMark(1, 17, schema.marks.bold!.create()));
    const marked = apply(steps);
    expect(citations(marked)).toEqual([{ locator: "str. 12", sourceId: S1, marks: 0 }]);
    expect(replayer.toCanonical(marked)).toMatchObject({
      nodes: [
        { children: [{ marks: ["bold"] }, { type: "citation" }, { marks: ["bold"] }] },
        {},
        {},
      ],
    });
    // With the text around it bold already, ProseMirror writes a step for the
    // citation alone: the editor's own step, accepted, changing nothing (§5.1).
    const again = capture((tr) => tr.addMark(1, 17, schema.marks.bold!.create()), marked);
    expect(again.steps).toEqual([{ stepType: "addMark", from: 7, to: 8, mark: { type: "bold" } }]);
    expect(apply(again.steps, marked).doc.eq(marked.doc)).toBe(true);
    // A step that changes nothing even before the citation is unmarked is refused.
    refused([{ stepType: "removeMark", from: 7, to: 8, mark: { type: "bold" } }]).toThrow(
      "step_changes_nothing",
    );
  });

  it("cannot name a position inside a citation: it has no inner positions", () => {
    expect(doc.resolve(7).nodeAfter?.type.name).toBe("citation");
    expect(doc.resolve(8).nodeBefore?.type.name).toBe("citation");
    expect(doc.nodeAt(7)?.nodeSize).toBe(1);
  });
});

describe("source steps (§5.3, class 27)", () => {
  const sources = (document: EditStepsV2Document) => document.sources.map((source) => source.id);

  it("appends a new source without a hash and refuses one with a hash", () => {
    expect(sources(apply([{ stepType: "sourceSet", source: book(S3) }]))).toEqual([S1, S2, S3]);
    refused([{ stepType: "sourceSet", source: book(S3), removedSha256: OTHER_HASH }]).toThrow(
      "removed_range_record",
    );
  });

  it("replaces an existing source in place only with the hash of the old record", () => {
    const changed = book(S1, { year: 2021 });
    const replaced = apply([
      { stepType: "sourceSet", source: changed, removedSha256: sourceRecordSha256(book(S1)) },
    ]);
    expect(replaced.sources).toEqual([changed, book(S2, { title: "Izvor 2" })]);
    refused([{ stepType: "sourceSet", source: changed }]).toThrow("removed_range_record");
    refused([{ stepType: "sourceSet", source: changed, removedSha256: OTHER_HASH }]).toThrow(
      "removed_range_hash",
    );
    refused([
      { stepType: "sourceSet", source: changed, removedSha256: sourceRecordSha256(changed) },
    ]).toThrow("removed_range_hash");
    refused([
      { stepType: "sourceSet", source: book(S1), removedSha256: sourceRecordSha256(book(S1)) },
    ]).toThrow("step_changes_nothing");
  });

  it("pins the record hash as SHA-256 of the record's JCS", () => {
    const json = canonicalizeJcs(book(S1) as unknown as JcsJsonValue);
    expect(json.startsWith('{"authors":[{"family":"Prezime","given":"Ime","kind":"person"}]')).toBe(
      true,
    );
    expect(sourceRecordSha256(book(S1))).toBe(
      createHash("sha256").update(json, "utf8").digest("hex"),
    );
  });

  it("refuses the 501st source", () => {
    const id = (n: number) => `dddddddd-dddd-4ddd-8ddd-${n.toString(16).padStart(12, "0")}`;
    const full = { ...state, sources: Array.from({ length: 500 }, (_, n) => book(id(n))) };
    refused([{ stepType: "sourceSet", source: book(S3) }], full).toThrow("too_many_sources");
    const less = { ...state, sources: full.sources.slice(1) };
    expect(apply([{ stepType: "sourceSet", source: book(S3) }], less).sources).toHaveLength(500);
  });

  it("removes a source only with the hash of its record, and leaves its citations", () => {
    const removed = apply([
      { stepType: "sourceRemove", sourceId: S1, removedSha256: sourceRecordSha256(book(S1)) },
    ]);
    expect(sources(removed)).toEqual([S2]);
    expect(citations(removed)).toEqual(citations(state));
    expect(replayer.toCanonical(removed)).toMatchObject({ sources: [{ id: S2 }] });
    refused([
      { stepType: "sourceRemove", sourceId: S3, removedSha256: sourceRecordSha256(book(S3)) },
    ]).toThrow("unknown_source");
    refused([{ stepType: "sourceRemove", sourceId: S1, removedSha256: OTHER_HASH }]).toThrow(
      "removed_range_hash",
    );
  });

  it("applies the steps of one event in order", () => {
    const changed = book(S3, { year: 2021 });
    const done = apply([
      { stepType: "sourceSet", source: book(S3) },
      { stepType: "sourceSet", source: changed, removedSha256: sourceRecordSha256(book(S3)) },
      { stepType: "sourceRemove", sourceId: S3, removedSha256: sourceRecordSha256(changed) },
    ]);
    expect(done.sources).toEqual(state.sources);
  });
});

describe("format selection (§5.4, class 28)", () => {
  const segment = (
    events: EvidenceEventV3[],
    initial: string,
    transactionFormat = "ductus-edit-steps-v2",
  ) =>
    ({
      initialDocumentHash: initial,
      finalDocumentHash: events.at(-1)?.afterDocumentHash ?? initial,
      events,
      captureContext: { editorModel: "prosemirror", transactionFormat },
    }) as unknown as EvidenceSegmentV2;
  const hashOf = async (document: EditStepsV2Document) =>
    (await digestCanonicalDocumentV2(replayer.toCanonical(document))).sha256;

  const v1Start: JcsJsonValue = {
    schemaVersion: 1,
    nodes: [{ type: "paragraph", id: A, children: [text("Odlomak.")] }],
  };

  it("replays a v2 segment from a v2 document", async () => {
    const steps = capture((tr) => tr.delete(7, 8)).steps;
    const after = apply(steps);
    const run = await replayEvidenceSegmentsV2(
      start,
      [
        segment(
          [
            {
              ...event(steps),
              beforeDocumentHash: await hashOf(state),
              afterDocumentHash: await hashOf(after),
            },
          ],
          await hashOf(state),
        ),
      ],
      replayer,
    );
    expect(run).toMatchObject({ ok: true, documentSha256: await hashOf(after) });
  });

  it("refuses a v1 document under v2 and a v2 document under v1", async () => {
    expect(() => replayer.load(v1Start)).toThrow("invalid_document");
    expect(await replayEvidenceSegmentsV2(v1Start, [], replayer)).toMatchObject({
      ok: false,
      reason: "invalid_document",
    });
    expect(await replayEvidenceSegmentsV2(start, [], createEditStepsV1Replayer())).toMatchObject({
      ok: false,
      reason: "invalid_document",
    });
  });

  it("refuses a segment whose transactionFormat is not the replayer's", async () => {
    const initial = await hashOf(state);
    expect(
      await replayEvidenceSegmentsV2(
        start,
        [segment([], initial, "ductus-edit-steps-v1")],
        replayer,
      ),
    ).toMatchObject({ ok: false, reason: "unsupported_format", segmentIndex: 0 });
  });

  it("reports a step that names an unknown node type as unsupported, a refused one as failed", async () => {
    const initial = await hashOf(state);
    const unknown = {
      stepType: "replace",
      from: 1,
      to: 1,
      slice: { content: [{ type: "footnote" }] },
    };
    expect(
      await replayEvidenceSegmentsV2(start, [segment([event([unknown])], initial)], replayer),
    ).toMatchObject({ ok: false, reason: "unsupported_format", sequence: 1 });
    const forged = { stepType: "replace", from: 7, to: 8, removedSha256: OTHER_HASH };
    expect(
      await replayEvidenceSegmentsV2(start, [segment([event([forged])], initial)], replayer),
    ).toMatchObject({ ok: false, reason: "step_failed", sequence: 1 });
  });
});

// SRV-33C: a work of document v2 records ductus-edit-steps-v1 (v4 §9 t. 9).
describe("ductus-edit-steps-v1 over document v2 (SRV-33C)", () => {
  const v1OnV2 = createEditStepsV1OnV2Replayer();
  const plain: JcsJsonValue = {
    schemaVersion: 2,
    nodes: [{ type: "paragraph", id: A, children: [text("Odlomak.")] }],
    sources: [book(S1)],
  } as unknown as JcsJsonValue;
  const plainState = v1OnV2.load(plain);

  it("names the v1 format and loads and writes document v2 only", () => {
    expect(v1OnV2.transactionFormat).toBe("ductus-edit-steps-v1");
    expect(v1OnV2.toCanonical(plainState)).toEqual(plain);
    expect(() =>
      v1OnV2.load({
        schemaVersion: 1,
        nodes: [{ type: "paragraph", id: A, children: [text("Odlomak.")] }],
      } as unknown as JcsJsonValue),
    ).toThrow("invalid_document");
  });

  it("applies a v1 insertion and a removal with its hash, as the v1 replayer would", () => {
    const inserted = v1OnV2.apply(
      plainState,
      event([
        { stepType: "replace", from: 9, to: 9, slice: { content: [{ type: "text", text: " B" }] } },
      ]),
    );
    expect(v1OnV2.toCanonical(inserted)).toMatchObject({
      schemaVersion: 2,
      nodes: [{ children: [text("Odlomak. B")] }],
      sources: [book(S1)],
    });
    const removed = v1OnV2.apply(
      inserted,
      event([
        {
          stepType: "replace",
          from: 9,
          to: 11,
          removedSha256: removedRangeSha256(inserted.doc, 9, 11),
        },
      ]),
    );
    expect(v1OnV2.toCanonical(removed)).toEqual(plain);
    expect(() =>
      v1OnV2.apply(
        inserted,
        event([{ stepType: "replace", from: 9, to: 11, removedSha256: OTHER_HASH }]),
      ),
    ).toThrow();
  });

  it("refuses what the v1 format does not have: a source step and a citation", () => {
    expect(() =>
      v1OnV2.apply(plainState, event([{ stepType: "sourceSet", source: book(S2) }])),
    ).toThrow();
    expect(() =>
      v1OnV2.apply(
        plainState,
        event([
          { stepType: "sourceRemove", sourceId: S1, removedSha256: sourceRecordSha256(book(S1)) },
        ]),
      ),
    ).toThrow();
    expect(() =>
      v1OnV2.apply(
        plainState,
        event([
          {
            stepType: "replace",
            from: 1,
            to: 1,
            slice: { content: [{ type: "citation", sourceId: S1 }] },
          },
        ]),
      ),
    ).toThrow();
    // The same steps in v2 are accepted, so the refusal is the format's.
    expect(() =>
      replayer.apply(plainState, event([{ stepType: "sourceSet", source: book(S2) }])),
    ).not.toThrow();
  });

  it("refuses a segment of any other format than v1", async () => {
    const initial = (await digestCanonicalDocumentV2(v1OnV2.toCanonical(plainState))).sha256;
    for (const transactionFormat of [
      "ductus-edit-steps-v2",
      "ductus-edit-steps-v3",
      "ductus-edit-steps-v4",
    ]) {
      expect(
        await replayEvidenceSegmentsV2(
          plain,
          [
            {
              initialDocumentHash: initial,
              finalDocumentHash: initial,
              events: [],
              captureContext: { editorModel: "prosemirror", transactionFormat },
            } as unknown as EvidenceSegmentV2,
          ],
          v1OnV2,
        ),
      ).toMatchObject({ ok: false, reason: "unsupported_format", segmentIndex: 0 });
    }
  });

  it("reads v1 steps only on the v2 schema, never on v3", () => {
    const run = runEditSteps(3, plainState, event([]), "ductus-edit-steps-v1" as never);
    expect(() => run.next()).toThrow("unsupported_format");
  });
});

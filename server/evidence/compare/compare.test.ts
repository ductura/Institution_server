// SRV-9E: the comparison of two versions over a real record replayed by the
// server's v1 step replayer. Synthetic only: invented ids and filler text.
import { createHash } from "node:crypto";

import type { Node as PmNode } from "@tiptap/pm/model";
import { Transform } from "@tiptap/pm/transform";
import { describe, expect, it, vi } from "vitest";

import type { ReplaySourceResult } from "../../database/index.ts";
import {
  canonicalEvidenceSegmentV2,
  canonicalizeJcs,
  EDIT_STEP_FORMAT_V1,
  EVIDENCE_CANONICALIZATION_V2,
  EVIDENCE_HASH_ALGORITHM_V2,
  EVIDENCE_SEGMENT_SCHEMA_V2,
  type EvidenceStepV2,
  type JcsJsonValue,
  REVISION_ZERO_JCS,
} from "../../domain/index.ts";
import {
  createEditStepsV1Replayer,
  InMemoryEvidencePayloadStore,
} from "../../external/storage/index.ts";

import { compareWorkVersions, MAX_COMPARE_SEGMENTS } from "./compare.ts";

const INSTITUTION = "11111111-1111-4111-8111-111111111111";
const PACKAGE = "pkg-test-z1";
const DOCUMENT = "doc-test-z1";
const BLOCK_B = "aaaaaaaa-0000-4000-8000-000000000002";
const replayer = createEditStepsV1Replayer();
const replayers = { v1: replayer };
const zero = replayer.load(JSON.parse(REVISION_ZERO_JCS) as JcsJsonValue);
const schema = zero.type.schema;
const sha = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const hashOf = (document: PmNode) => sha(canonicalizeJcs(replayer.toCanonical(document)));
// Another start than revision 0: a record from it, or a segment after it, is a break.
const elsewhere = replayer.load({
  schemaVersion: 1,
  nodes: [
    {
      type: "paragraph",
      id: "aaaaaaaa-0000-4000-8000-000000000001",
      children: [{ type: "text", text: "Drugi tekst.", marks: [] }],
    },
  ],
} as JcsJsonValue);

type Edit = (tr: Transform) => void;
type Plan = { edit: Edit; from?: PmNode };

/**
 * One segment of one event per plan, as capture writes it: the steps in
 * ProseMirror's JSON, a removing replace with its removedSha256 (the JCS of
 * the removed slice, ductus-edit-steps-v1), chained by hash and sequence.
 */
function buildRecord(start: PmNode, plans: Plan[]) {
  const segments: string[] = [];
  const hashes: string[] = [];
  let document = start;
  for (const [index, plan] of plans.entries()) {
    document = plan.from ?? document;
    const before = hashOf(document);
    const tr = new Transform(document);
    plan.edit(tr);
    const steps = tr.steps.map((step, i) => {
      const value = step.toJSON() as Record<string, unknown>;
      const [from, to] = [value.from as number, value.to as number];
      if (value.stepType === "replace" && to > from && !value.structure) {
        value.removedSha256 = sha(canonicalizeJcs(tr.docs[i]!.slice(from, to).toJSON()));
      }
      return value as EvidenceStepV2;
    });
    document = tr.doc;
    const sequence = index + 1;
    const payload = canonicalEvidenceSegmentV2({
      evidenceSchema: EVIDENCE_SEGMENT_SCHEMA_V2,
      canonicalization: EVIDENCE_CANONICALIZATION_V2,
      hashAlgorithm: EVIDENCE_HASH_ALGORITHM_V2,
      documentId: DOCUMENT,
      sessionId: "session-test",
      segmentId: `segment-${sequence}`,
      sequenceFrom: sequence,
      sequenceTo: sequence,
      observedStartedAt: "2026-10-20T10:00:00.000Z",
      observedEndedAt: "2026-10-20T10:00:00.000Z",
      initialDocumentHash: before,
      finalDocumentHash: hashOf(document),
      predecessorSegmentHash: hashes.at(-1) ?? null,
      events: [
        {
          sequence,
          source: "editor",
          steps,
          beforeDocumentHash: before,
          afterDocumentHash: hashOf(document),
        },
      ],
      captureContext: { editorModel: "prosemirror", transactionFormat: EDIT_STEP_FORMAT_V1 },
      evidenceProfileId: "standard-v1",
    });
    segments.push(payload);
    hashes.push(sha(payload));
  }
  return { segments, hashes };
}

/** Revision 1 types a paragraph, 2 adds a second one, 3 removes a word of the first. */
function threeRevisions() {
  return buildRecord(zero, [
    { edit: (tr) => tr.insert(1, schema.text("Prvi odlomak lorem.")) },
    {
      edit: (tr) => {
        // A split makes the new block without an id; an attr step gives it one.
        const end = tr.doc.content.size - 1;
        tr.split(end, 1, [{ type: schema.nodes.paragraph!, attrs: { nodeId: null } }]);
        tr.setNodeAttribute(end + 1, "nodeId", BLOCK_B);
        tr.insert(end + 2, schema.text("Drugi odlomak ipsum."));
      },
    },
    { edit: (tr) => tr.delete(1, 6) },
  ]);
}

type Built = { segments: string[]; hashes: string[] };

async function depsOf(record: Built, answer?: ReplaySourceResult) {
  const store = new InMemoryEvidencePayloadStore();
  for (const [index, canonicalPayload] of record.segments.entries()) {
    await store.putImmutable({
      institutionId: INSTITUTION,
      evidencePackageId: PACKAGE,
      segmentHash: record.hashes[index]!,
      canonicalPayload,
    });
  }
  const source = {
    readSource: vi.fn(
      async (): Promise<ReplaySourceResult> =>
        answer ?? {
          status: "found",
          institutionId: INSTITUTION,
          evidencePackageId: PACKAGE,
          head: { segmentHash: record.hashes.at(-1)!, segmentCount: record.hashes.length },
          segmentHashes: [...record.hashes],
        },
    ),
  };
  const readImmutable = vi.fn(store.readImmutable.bind(store));
  return { source, payloads: { readImmutable }, replayers };
}

describe("compareWorkVersions", () => {
  it("answers the difference by blocks between any two revisions of the record", async () => {
    const deps = await depsOf(threeRevisions());
    expect(await compareWorkVersions(deps, DOCUMENT, 1, 3)).toStrictEqual({
      status: "ok",
      from: 1,
      to: 3,
      blocks: [
        { change: "removed", kind: "paragraph", text: "Prvi odlomak lorem." },
        { change: "added", kind: "paragraph", text: "odlomak lorem." },
        { change: "added", kind: "paragraph", text: "Drugi odlomak ipsum." },
      ],
    });
    expect(await compareWorkVersions(deps, DOCUMENT, 2, 3)).toStrictEqual({
      status: "ok",
      from: 2,
      to: 3,
      blocks: [
        { change: "removed", kind: "paragraph", text: "Prvi odlomak lorem." },
        { change: "added", kind: "paragraph", text: "odlomak lorem." },
        { change: "unchanged", kind: "paragraph", text: "Drugi odlomak ipsum." },
      ],
    });
  });

  it("reads no segment after the later revision", async () => {
    const deps = await depsOf(threeRevisions());
    const result = await compareWorkVersions(deps, DOCUMENT, 1, 2);
    expect(result).toMatchObject({ status: "ok", from: 1, to: 2 });
    expect(deps.payloads.readImmutable).toHaveBeenCalledTimes(2);
  });

  it.each([
    [0, 1],
    [2, 2],
    [3, 1],
    [1.5, 3],
    [1, Number.MAX_SAFE_INTEGER + 1],
  ])("refuses from %s to %s as invalid input before any read", async (from, to) => {
    const deps = await depsOf(threeRevisions());
    expect(await compareWorkVersions(deps, DOCUMENT, from, to)).toStrictEqual({
      status: "invalid_input",
    });
    expect(deps.source.readSource).not.toHaveBeenCalled();
  });

  it("answers a document id that cannot exist as not found, before the source", async () => {
    const deps = await depsOf(threeRevisions());
    expect(await compareWorkVersions(deps, " doc", 1, 2)).toStrictEqual({ status: "not_found" });
    expect(deps.source.readSource).not.toHaveBeenCalled();
  });

  it("answers a revision beyond the record (the submission cut) as not found", async () => {
    const deps = await depsOf(threeRevisions());
    expect(await compareWorkVersions(deps, DOCUMENT, 1, 4)).toStrictEqual({
      status: "not_found",
    });
    expect(deps.payloads.readImmutable).not.toHaveBeenCalled();
  });

  it.each(["not_found", "unauthenticated"] as const)(
    "passes the source's %s through and reads nothing",
    async (status) => {
      const deps = await depsOf(threeRevisions(), { status });
      expect(await compareWorkVersions(deps, DOCUMENT, 1, 2)).toStrictEqual({ status });
      expect(deps.payloads.readImmutable).not.toHaveBeenCalled();
    },
  );

  it("answers a source that throws or is unavailable as unavailable", async () => {
    const deps = await depsOf(threeRevisions());
    deps.source.readSource.mockRejectedValueOnce(new Error("down"));
    expect(await compareWorkVersions(deps, DOCUMENT, 1, 2)).toStrictEqual({
      status: "unavailable",
      reason: "source_unavailable",
    });
    const other = await depsOf(threeRevisions(), { status: "unavailable", reason: "x" });
    expect(await compareWorkVersions(other, DOCUMENT, 1, 2)).toStrictEqual({
      status: "unavailable",
      reason: "source_unavailable",
    });
  });

  it("refuses a later revision above the segment limit as too large before any read", async () => {
    const hashes = Array.from({ length: MAX_COMPARE_SEGMENTS + 1 }, (_, i) =>
      i.toString(16).padStart(64, "0"),
    );
    const deps = await depsOf({ segments: [], hashes });
    expect(await compareWorkVersions(deps, DOCUMENT, 1, MAX_COMPARE_SEGMENTS + 1)).toStrictEqual({
      status: "too_large",
    });
    expect(deps.payloads.readImmutable).not.toHaveBeenCalled();
  });

  it("answers a missing or a changed stored segment as unavailable", async () => {
    const record = threeRevisions();
    const missing = await depsOf({ segments: record.segments.slice(0, 1), hashes: record.hashes });
    expect(await compareWorkVersions(missing, DOCUMENT, 1, 2)).toStrictEqual({
      status: "unavailable",
      reason: "payload_missing",
    });
    const listed = [...record.hashes];
    listed[0] = sha("another segment");
    const changed = await depsOf(record, {
      status: "found",
      institutionId: INSTITUTION,
      evidencePackageId: PACKAGE,
      head: { segmentHash: listed.at(-1)!, segmentCount: 3 },
      segmentHashes: listed,
    });
    expect(await compareWorkVersions(changed, DOCUMENT, 1, 2)).toStrictEqual({
      status: "unavailable",
      reason: "payload_missing",
    });
  });

  it("answers a segment of another document or bytes that are no segment as unavailable", async () => {
    const deps = await depsOf(threeRevisions());
    expect(await compareWorkVersions(deps, "doc-test-other", 1, 2)).toStrictEqual({
      status: "unavailable",
      reason: "segment_mismatch",
    });
    deps.payloads.readImmutable.mockResolvedValueOnce({
      status: "found",
      bytes: new TextEncoder().encode("{}"),
    });
    expect(await compareWorkVersions(deps, DOCUMENT, 1, 2)).toStrictEqual({
      status: "unavailable",
      reason: "invalid_segment",
    });
  });

  // B-12: the removed range of revision 3 does not hash to its removedSha256.
  // The segment is well formed and listed under its own hash, so only the
  // server's replay can refuse it, and no text is answered.
  it("never answers a text whose removed range does not match its removedSha256", async () => {
    const record = threeRevisions();
    const last = JSON.parse(record.segments[2]!) as {
      events: { steps: { removedSha256?: string }[] }[];
    };
    const step = last.events[0]!.steps.find((s) => s.removedSha256 !== undefined)!;
    step.removedSha256 = "0".repeat(64);
    const tampered = canonicalizeJcs(last as unknown as JcsJsonValue);
    const segments = [...record.segments.slice(0, 2), tampered];
    const hashes = [...record.hashes.slice(0, 2), sha(tampered)];
    const deps = await depsOf({ segments, hashes });
    expect(await compareWorkVersions(deps, DOCUMENT, 1, 3)).toStrictEqual({
      status: "unavailable",
      reason: "replay_failed",
    });
    expect(await compareWorkVersions(deps, DOCUMENT, 1, 2)).toMatchObject({
      status: "ok",
    });
  });

  it("answers a record with a break before the later revision as unavailable", async () => {
    const record = buildRecord(zero, [
      { edit: (tr) => tr.insert(1, schema.text("Odlomak A.")) },
      { from: elsewhere, edit: (tr) => tr.insert(1, schema.text("x")) },
    ]);
    const deps = await depsOf(record);
    expect(await compareWorkVersions(deps, DOCUMENT, 1, 2)).toStrictEqual({
      status: "unavailable",
      reason: "record_break",
    });
  });

  it("answers a record that does not start at revision 0 as unavailable", async () => {
    const record = buildRecord(elsewhere, [
      { edit: (tr) => tr.insert(1, schema.text("x")) },
      { edit: (tr) => tr.insert(1, schema.text("y")) },
    ]);
    const deps = await depsOf(record);
    expect(await compareWorkVersions(deps, DOCUMENT, 1, 2)).toStrictEqual({
      status: "unavailable",
      reason: "record_break",
    });
  });

  it("answers a record in a format with no replayer given as unavailable", async () => {
    const deps = await depsOf(threeRevisions());
    const v3Only = { ...deps, replayers: { v1: { ...replayer, transactionFormat: "other" } } };
    expect(await compareWorkVersions(v3Only, DOCUMENT, 1, 2)).toStrictEqual({
      status: "unavailable",
      reason: "unsupported_format",
    });
  });
});

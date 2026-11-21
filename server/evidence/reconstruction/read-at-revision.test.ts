import { describe, expect, it } from "vitest";

import { sha256WebCrypto } from "../../domain/index.ts";
import { checkpointRevisionsDue, verifyReconstructionCheckpoint } from "./checkpoint.ts";
import { buildReconstructionCheckpoints, readDocumentAtRevision } from "./read-at-revision.ts";
import {
  buildRecord,
  canonical,
  canonicalText,
  checkpointOf,
  EMPTY,
  inventedTexts,
  replayer,
} from "./record.fixture.ts";

// SRV-1503 (plan M3.3, B-12): reading a revision from a reconstruction
// checkpoint. The record and every text are invented (record.fixture.ts).
const record = await buildRecord(inventedTexts(12));
const start = canonical(EMPTY);
const read = (
  revision: number,
  checkpoint: Parameters<typeof readDocumentAtRevision>[0]["checkpoint"],
) =>
  readDocumentAtRevision({
    initialDocument: start,
    segments: record.segments,
    revision,
    replayer,
    checkpoint,
  });

describe("readDocumentAtRevision", () => {
  it("reads every revision from the full record when there is no checkpoint", async () => {
    for (let revision = 0; revision <= record.segments.length; revision++) {
      const result = await read(revision, null);
      expect(result).toMatchObject({
        ok: true,
        source: "full",
        startRevision: 0,
        fallback: null,
        canonicalDocument: canonicalText(record.documents[revision]!),
      });
    }
  });

  it("starts at a valid checkpoint and gives the same bytes as the full record", async () => {
    const checkpoint = await checkpointOf(record, 5);
    for (const revision of [5, 6, 12]) {
      const resumed = await read(revision, checkpoint);
      const full = await read(revision, null);
      expect(resumed).toMatchObject({
        ok: true,
        source: "checkpoint",
        startRevision: 5,
        fallback: null,
      });
      if (!resumed.ok || !full.ok) throw new Error("unreachable");
      expect(resumed.canonicalDocument).toBe(full.canonicalDocument);
      expect(resumed.documentSha256).toBe(full.documentSha256);
    }
  });

  it("does not replay the segments before the checkpoint", async () => {
    const checkpoint = await checkpointOf(record, 8);
    // A segment before the checkpoint that cannot be replayed is never touched.
    const broken = record.segments.map((item, at) =>
      at === 2
        ? {
            ...item,
            segment: {
              ...item.segment,
              captureContext: {
                ...item.segment.captureContext,
                transactionFormat: "ductus-edit-steps-v3" as const,
              },
            },
          }
        : item,
    );
    const resumed = await readDocumentAtRevision({
      initialDocument: start,
      segments: broken,
      revision: 10,
      replayer,
      checkpoint,
    });
    expect(resumed).toMatchObject({ ok: true, source: "checkpoint", startRevision: 8 });
  });

  it.each([
    [
      "damaged text",
      async () => ({
        ...(await checkpointOf(record, 5)),
        body: canonicalText(record.documents[4]!),
      }),
    ],
    [
      "damaged text with its own hash",
      async () => {
        const body = canonicalText(record.documents[4]!);
        return {
          ...(await checkpointOf(record, 5)),
          body,
          contentHash: await sha256WebCrypto(body),
        };
      },
    ],
    [
      "wrong content hash",
      async () => ({ ...(await checkpointOf(record, 5)), contentHash: "0".repeat(64) }),
    ],
    [
      "another position",
      async () => ({
        ...(await checkpointOf(record, 5)),
        segmentHash: record.segments[3]!.segmentHash,
      }),
    ],
    [
      "non-canonical text",
      async () => {
        const body = JSON.stringify({ nodes: record.documents[5]!.nodes }, null, 1);
        return {
          ...(await checkpointOf(record, 5)),
          body,
          contentHash: await sha256WebCrypto(body),
        };
      },
    ],
    ["text that is not JSON", async () => ({ ...(await checkpointOf(record, 5)), body: "{" })],
  ])("rejects a checkpoint with %s and falls back to the full record", async (_label, make) => {
    const checkpoint = await make();
    const result = await read(9, checkpoint);
    expect(result).toMatchObject({
      ok: true,
      source: "full",
      startRevision: 0,
      canonicalDocument: canonicalText(record.documents[9]!),
    });
    if (!result.ok) throw new Error("unreachable");
    expect(result.fallback).not.toBeNull();
  });

  it("names the reason a checkpoint was passed over", async () => {
    const valid = await checkpointOf(record, 5);
    expect((await read(9, { ...valid, contentHash: "0".repeat(64) })).fallback).toBe(
      "hash_mismatch",
    );
    expect((await read(9, { ...valid, segmentHash: "1".repeat(64) })).fallback).toBe(
      "position_mismatch",
    );
    expect((await read(4, valid)).fallback).toBe("beyond_revision");
    expect((await read(9, { ...valid, body: "{" })).fallback).toBe("hash_mismatch");
  });

  it("falls back when the store gave no answer", async () => {
    const result = await readDocumentAtRevision({
      initialDocument: start,
      segments: record.segments,
      revision: 7,
      replayer,
      checkpoint: null,
      checkpointUnavailable: true,
    });
    expect(result).toMatchObject({ ok: true, source: "full", fallback: "unavailable" });
  });

  it("refuses a revision outside the record", async () => {
    for (const revision of [-1, 13, 1.5, Number.NaN]) {
      expect(await read(revision, null)).toMatchObject({
        ok: false,
        reason: "revision_out_of_range",
      });
    }
  });

  it("reports the failing segment of a record that does not replay, from the start", async () => {
    const broken = record.segments.map((item, at) =>
      at === 6
        ? { ...item, segment: { ...item.segment, initialDocumentHash: "2".repeat(64) } }
        : item,
    );
    const result = await readDocumentAtRevision({
      initialDocument: start,
      segments: broken,
      revision: 10,
      replayer,
      checkpoint: null,
    });
    expect(result).toMatchObject({ ok: false, reason: "document_hash_mismatch", segmentIndex: 6 });
  });
});

describe("verifyReconstructionCheckpoint", () => {
  it("accepts the checkpoint a correct store holds", async () => {
    const verified = await verifyReconstructionCheckpoint(
      await checkpointOf(record, 3),
      record.segments,
      3,
      replayer,
    );
    expect(verified).toEqual({ ok: true, document: record.documents[3] });
  });

  it("refuses a revision of 0 or past the record", async () => {
    const valid = await checkpointOf(record, 3);
    for (const revision of [0, -2, 13]) {
      expect(
        await verifyReconstructionCheckpoint({ ...valid, revision }, record.segments, 12, replayer),
      ).toEqual({ ok: false, reason: "beyond_revision" });
    }
  });
});

describe("buildReconstructionCheckpoints", () => {
  it("builds the asked checkpoints in one pass, each the checkpoint a correct store holds", async () => {
    const built = await buildReconstructionCheckpoints({
      initialDocument: start,
      segments: record.segments,
      revisions: [4, 8, 12],
      replayer,
    });
    expect(built).toEqual({
      ok: true,
      checkpoints: [
        await checkpointOf(record, 4),
        await checkpointOf(record, 8),
        await checkpointOf(record, 12),
      ],
    });
  });

  it("builds nothing from a record that does not replay", async () => {
    const broken = record.segments.map((item, at) =>
      at === 1
        ? { ...item, segment: { ...item.segment, finalDocumentHash: "3".repeat(64) } }
        : item,
    );
    expect(
      await buildReconstructionCheckpoints({
        initialDocument: start,
        segments: broken,
        revisions: [4],
        replayer,
      }),
    ).toMatchObject({ ok: false, segmentIndex: 1 });
  });
});

describe("checkpointRevisionsDue", () => {
  it("lists every interval after the newest checkpoint", () => {
    expect(checkpointRevisionsDue(120, null, 50)).toEqual([50, 100]);
    expect(checkpointRevisionsDue(120, 50, 50)).toEqual([100]);
    expect(checkpointRevisionsDue(120, 100, 50)).toEqual([]);
    expect(checkpointRevisionsDue(49, null, 50)).toEqual([]);
    expect(checkpointRevisionsDue(150, null)).toEqual([50, 100, 150]);
  });

  it("refuses an interval that is no positive integer", () => {
    expect(() => checkpointRevisionsDue(10, null, 0)).toThrow(RangeError);
    expect(() => checkpointRevisionsDue(10, null, 1.5)).toThrow(RangeError);
  });
});

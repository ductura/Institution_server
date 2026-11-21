import { describe, expect, it } from "vitest";

import type { ReconstructionCheckpoint } from "./checkpoint.ts";
import {
  buildRecord,
  canonical,
  canonicalText,
  checkpointOf,
  EMPTY,
  inventedTexts,
  replayer,
} from "./record.fixture.ts";
import { readPackageRevision, recordDueCheckpoints } from "./service.ts";
import type { CheckpointRecordResult, ReconstructionCheckpointStore } from "./store.ts";

// SRV-1503: the store, the read and the writer together, over an in-memory
// store that behaves like the database (append-only, newest at or before).
const PACKAGE = "paket-izmisljeni-1503";
const record = await buildRecord(inventedTexts(23));
const start = canonical(EMPTY);

function memoryStore(options: { failReads?: boolean; refuse?: CheckpointRecordResult } = {}) {
  const rows = new Map<number, ReconstructionCheckpoint>();
  const reads: number[] = [];
  const store: ReconstructionCheckpointStore = {
    async readAtOrBefore({ revision }) {
      reads.push(revision);
      if (options.failReads) return { status: "unavailable", reason: "checkpoints_failed" };
      const newest = [...rows.keys()].filter((r) => r <= revision).sort((a, b) => b - a)[0];
      return newest === undefined
        ? { status: "none" }
        : { status: "found", checkpoint: rows.get(newest)! };
    },
    async record({ checkpoint }) {
      if (options.refuse) return options.refuse;
      if (rows.has(checkpoint.revision)) return { status: "exists" };
      rows.set(checkpoint.revision, checkpoint);
      return { status: "recorded" };
    },
  };
  return { rows, reads, store };
}

const base = { evidencePackageId: PACKAGE, initialDocument: start, replayer };

describe("recordDueCheckpoints", () => {
  it("writes one checkpoint every interval and nothing twice", async () => {
    const { rows, store } = memoryStore();
    expect(
      await recordDueCheckpoints({ ...base, store, segments: record.segments, interval: 5 }),
    ).toEqual({
      status: "done",
      recorded: [5, 10, 15, 20],
      existing: [],
    });
    expect(rows.get(10)).toEqual(await checkpointOf(record, 10));
    expect(
      await recordDueCheckpoints({ ...base, store, segments: record.segments, interval: 5 }),
    ).toEqual({
      status: "done",
      recorded: [],
      existing: [],
    });
  });

  it("writes nothing for a record shorter than the interval", async () => {
    const { rows, store } = memoryStore();
    expect(await recordDueCheckpoints({ ...base, store, segments: record.segments })).toEqual({
      status: "done",
      recorded: [],
      existing: [],
    });
    expect(rows.size).toBe(0);
  });

  it("stops on a refusal and on a store that does not answer", async () => {
    const refused = memoryStore({ refuse: { status: "mismatch" } });
    expect(
      await recordDueCheckpoints({
        ...base,
        store: refused.store,
        segments: record.segments,
        interval: 5,
      }),
    ).toEqual({
      status: "stopped",
      recorded: [],
      reason: "mismatch",
    });
    const down = memoryStore({ failReads: true });
    expect(
      await recordDueCheckpoints({
        ...base,
        store: down.store,
        segments: record.segments,
        interval: 5,
      }),
    ).toEqual({
      status: "stopped",
      recorded: [],
      reason: "checkpoints_failed",
    });
  });

  it("writes nothing from a record that does not replay", async () => {
    const { rows, store } = memoryStore();
    const broken = record.segments.map((item, at) =>
      at === 3
        ? { ...item, segment: { ...item.segment, finalDocumentHash: "4".repeat(64) } }
        : item,
    );
    expect(await recordDueCheckpoints({ ...base, store, segments: broken, interval: 5 })).toEqual({
      status: "not_reproducible",
      segmentIndex: 3,
    });
    expect(rows.size).toBe(0);
  });
});

describe("readPackageRevision", () => {
  it("reads a revision from the newest checkpoint at or before it", async () => {
    const { reads, store } = memoryStore();
    await recordDueCheckpoints({ ...base, store, segments: record.segments, interval: 5 });
    reads.length = 0;
    const result = await readPackageRevision({
      ...base,
      store,
      segments: record.segments,
      revision: 17,
    });
    expect(reads).toEqual([17]);
    expect(result).toMatchObject({
      ok: true,
      source: "checkpoint",
      startRevision: 15,
      canonicalDocument: canonicalText(record.documents[17]!),
    });
  });

  it("falls back to the full record when the store does not answer", async () => {
    const { store } = memoryStore({ failReads: true });
    expect(
      await readPackageRevision({ ...base, store, segments: record.segments, revision: 9 }),
    ).toMatchObject({
      ok: true,
      source: "full",
      fallback: "unavailable",
      canonicalDocument: canonicalText(record.documents[9]!),
    });
  });

  it("falls back when the stored checkpoint is damaged", async () => {
    const { rows, store } = memoryStore();
    const valid = await checkpointOf(record, 10);
    rows.set(10, { ...valid, body: canonicalText(record.documents[9]!) });
    expect(
      await readPackageRevision({ ...base, store, segments: record.segments, revision: 12 }),
    ).toMatchObject({
      ok: true,
      source: "full",
      fallback: "hash_mismatch",
      canonicalDocument: canonicalText(record.documents[12]!),
    });
  });

  it("reads revision 0 without asking the store", async () => {
    const { reads, store } = memoryStore();
    expect(
      await readPackageRevision({ ...base, store, segments: record.segments, revision: 0 }),
    ).toMatchObject({
      ok: true,
      canonicalDocument: canonicalText(EMPTY),
    });
    expect(reads).toEqual([]);
  });
});

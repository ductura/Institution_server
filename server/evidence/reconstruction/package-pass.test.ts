import { describe, expect, it } from "vitest";

import { canonicalEvidenceSegmentV2, type EvidenceSegmentV2 } from "../../domain/index.ts";
import type { ReconstructionCheckpoint } from "./checkpoint.ts";
import type { PackageChain, PackageChainResult } from "./chain-source.ts";
import { createPackageCheckpointRecorder, MAX_CHAIN_BYTES } from "./package-pass.ts";
import {
  buildRecord,
  canonical,
  canonicalText,
  checkpointOf,
  EMPTY,
  inventedTexts,
  replayer,
} from "./record.fixture.ts";
import type { ReconstructionCheckpointStore } from "./store.ts";

// F4-PM2-R02: the recorder reads a package's chain and its segment objects,
// verifies them against the head and only then writes the due checkpoints.
// Every package, institution and text below is invented.
const PACKAGE = "paket-izmisljeni-pm2";
const INSTITUTION = "00000000-0000-4000-8000-0000000000f1";
const record = await buildRecord(inventedTexts(23));
const encode = (segment: EvidenceSegmentV2) =>
  new TextEncoder().encode(canonicalEvidenceSegmentV2(segment));
const objects = new Map(
  record.segments.map(({ segmentHash, segment }) => [
    segmentHash,
    encode(segment as EvidenceSegmentV2),
  ]),
);
const chainOf = (overrides: Partial<PackageChain> = {}): PackageChain => ({
  headSegmentHash: record.segments.at(-1)!.segmentHash,
  segmentHashes: record.segments.map((s) => s.segmentHash),
  initialDocument: canonicalText(EMPTY),
  ...overrides,
});

function memoryStore() {
  const rows = new Map<number, ReconstructionCheckpoint>();
  const store: ReconstructionCheckpointStore = {
    async readAtOrBefore({ revision }) {
      const newest = [...rows.keys()].filter((r) => r <= revision).sort((a, b) => b - a)[0];
      return newest === undefined
        ? { status: "none" }
        : { status: "found", checkpoint: rows.get(newest)! };
    },
    async record({ checkpoint }) {
      if (rows.has(checkpoint.revision)) return { status: "exists" };
      rows.set(checkpoint.revision, checkpoint);
      return { status: "recorded" };
    },
  };
  return { rows, store };
}

function recorderOver(
  options: {
    read?: PackageChainResult | (() => never);
    objects?: Map<string, Uint8Array>;
    payloadStatus?: "unavailable" | "throw";
    replayerFor?: Parameters<typeof createPackageCheckpointRecorder<unknown>>[0]["replayerFor"];
  } = {},
) {
  const { rows, store } = memoryStore();
  const reads: string[] = [];
  const stored = options.objects ?? objects;
  const recorder = createPackageCheckpointRecorder({
    source: {
      async readChain() {
        if (typeof options.read === "function") return options.read();
        return options.read ?? { status: "found", chain: chainOf() };
      },
    },
    payloads: {
      async readImmutable({ institutionId, evidencePackageId, segmentHash }) {
        expect(institutionId).toBe(INSTITUTION);
        expect(evidencePackageId).toBe(PACKAGE);
        reads.push(segmentHash);
        if (options.payloadStatus === "throw") throw new Error("storage down");
        if (options.payloadStatus === "unavailable")
          return { status: "unavailable", reason: "timeout" };
        const bytes = stored.get(segmentHash);
        return bytes ? { status: "found", bytes } : { status: "not_found" };
      },
    },
    store,
    replayerFor: options.replayerFor ?? (() => replayer),
    interval: 5,
  });
  return { rows, reads, recorder };
}

const ask = (recorder: ReturnType<typeof recorderOver>["recorder"]) =>
  recorder.recordPackage({ evidencePackageId: PACKAGE, institutionId: INSTITUTION });

describe("createPackageCheckpointRecorder", () => {
  it("verifies the record and writes the checkpoint of every interval", async () => {
    const { rows, reads, recorder } = recorderOver();
    expect(await ask(recorder)).toEqual({ status: "recorded", written: 4 });
    expect([...rows.keys()]).toEqual([5, 10, 15, 20]);
    expect(rows.get(15)).toEqual(await checkpointOf(record, 15));
    expect(reads).toHaveLength(23);
    expect(await ask(recorder)).toEqual({ status: "current" });
  });

  it("writes nothing when the stored object is not the one the head names", async () => {
    const forged = new Map(objects);
    const [victim] = record.segments.slice(7, 8);
    forged.set(victim!.segmentHash, encode(record.segments[6]!.segment as EvidenceSegmentV2));
    const { rows, recorder } = recorderOver({ objects: forged });
    expect(await ask(recorder)).toEqual({ status: "skipped", reason: "broken_chain" });
    expect(rows.size).toBe(0);
  });

  it("writes nothing when the head is not the newest segment", async () => {
    const { rows, recorder } = recorderOver({
      read: {
        status: "found",
        chain: chainOf({ headSegmentHash: record.segments[10]!.segmentHash }),
      },
    });
    expect(await ask(recorder)).toEqual({ status: "skipped", reason: "broken_chain" });
    expect(rows.size).toBe(0);
  });

  it("writes nothing for a record that does not start from the document it names", async () => {
    const other = { ...(canonical(EMPTY) as object), nodes: [{ id: "drugi-odlomak", text: "x" }] };
    const { rows, recorder } = recorderOver({
      read: { status: "found", chain: chainOf({ initialDocument: JSON.stringify(other) }) },
    });
    expect(await ask(recorder)).toEqual({ status: "skipped", reason: "not_reproducible" });
    expect(rows.size).toBe(0);
  });

  it("skips a missing object, an unknown version and a package without a chain", async () => {
    const missing = new Map(objects);
    missing.delete(record.segments[3]!.segmentHash);
    expect(await ask(recorderOver({ objects: missing }).recorder)).toEqual({
      status: "skipped",
      reason: "broken_chain",
    });
    const versioned = JSON.stringify({ ...(canonical(EMPTY) as object), schemaVersion: 9 });
    const seen: (number | null)[] = [];
    const unknown = recorderOver({
      read: { status: "found", chain: chainOf({ initialDocument: versioned }) },
      replayerFor: (version) => (seen.push(version), null),
    });
    expect(await ask(unknown.recorder)).toEqual({
      status: "skipped",
      reason: "unsupported_document",
    });
    expect(seen).toEqual([9]);
    expect(unknown.reads).toEqual([]);
    for (const initialDocument of [null, "not json", "[]"]) {
      const bad = recorderOver({
        read: { status: "found", chain: chainOf({ initialDocument }) },
      });
      expect(await ask(bad.recorder)).toEqual({
        status: "skipped",
        reason: "unsupported_document",
      });
    }
    expect(await ask(recorderOver({ read: { status: "none" } }).recorder)).toEqual({
      status: "skipped",
      reason: "no_chain",
    });
  });

  it("leaves a chain alone whose objects do not fit the memory bound", async () => {
    const big = new Map(objects);
    big.set(record.segments[0]!.segmentHash, new Uint8Array(MAX_CHAIN_BYTES + 1));
    const { rows, recorder } = recorderOver({ objects: big });
    expect(await ask(recorder)).toEqual({ status: "skipped", reason: "chain_too_long" });
    expect(rows.size).toBe(0);
  });

  it("is unavailable, not skipped, when a read does not answer", async () => {
    expect(
      await ask(
        recorderOver({ read: { status: "unavailable", reason: "source_failed" } }).recorder,
      ),
    ).toEqual({ status: "unavailable", reason: "source_failed" });
    expect(
      await ask(
        recorderOver({
          read: () => {
            throw new Error("down");
          },
        }).recorder,
      ),
    ).toEqual({ status: "unavailable", reason: "source_failed" });
    for (const payloadStatus of ["unavailable", "throw"] as const) {
      const { rows, recorder } = recorderOver({ payloadStatus });
      expect(await ask(recorder)).toEqual({ status: "unavailable", reason: "storage_failed" });
      expect(rows.size).toBe(0);
    }
  });
});

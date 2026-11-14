// Ported from Ductus src/application/ports/evidence-object-key.test.ts at
// d52a92c3, the in-memory store part (S-0.19, DAN-732).
import { describe, expect, it } from "vitest";

import { InMemoryEvidencePayloadStore } from "./in-memory-evidence-payload-store.ts";
import { bindPayloadReader } from "./port.ts";

// Synthetic ids only.
const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const HASH = "a".repeat(64);

describe("in-memory payload store keyed by institution", () => {
  const payload = '{"x":1}';

  it("stores the same hash again in another institution, never answering existing across them (P5)", async () => {
    const store = new InMemoryEvidencePayloadStore();
    const inA = await store.putImmutable({
      institutionId: A,
      evidencePackageId: "paket-a",
      segmentHash: HASH,
      canonicalPayload: payload,
    });
    const inB = await store.putImmutable({
      institutionId: B,
      evidencePackageId: "paket-b",
      segmentHash: HASH,
      canonicalPayload: payload,
    });

    expect(inA).toEqual({ status: "stored", storageRef: `memory:v2/${A}/paket-a/${HASH}.json` });
    expect(inB).toEqual({ status: "stored", storageRef: `memory:v2/${B}/paket-b/${HASH}.json` });
    expect(store.size).toBe(2);
  });

  it("refuses a package under a second institution and an invalid key, storing nothing", async () => {
    const store = new InMemoryEvidencePayloadStore();
    await store.putImmutable({
      institutionId: A,
      evidencePackageId: "paket-a",
      segmentHash: HASH,
      canonicalPayload: payload,
    });

    for (const input of [
      { institutionId: B, evidencePackageId: "paket-a" },
      { institutionId: A.toUpperCase(), evidencePackageId: "paket-c" },
      { institutionId: A, evidencePackageId: "Paket-C" },
    ]) {
      expect(
        await store.putImmutable({ ...input, segmentHash: HASH, canonicalPayload: payload }),
      ).toEqual({ status: "invalid" });
    }
    expect(store.size).toBe(1);
    expect(await store.readImmutable({ evidencePackageId: "paket-a", segmentHash: HASH })).toEqual({
      status: "found",
      bytes: new TextEncoder().encode(payload),
    });
  });

  it("reads a package through its own institution only, also through a bound reader (B2)", async () => {
    const store = new InMemoryEvidencePayloadStore();
    await store.putImmutable({
      institutionId: A,
      evidencePackageId: "paket-a",
      segmentHash: HASH,
      canonicalPayload: payload,
    });
    const read = { evidencePackageId: "paket-a", segmentHash: HASH };

    await expect(bindPayloadReader(store, A).readImmutable(read)).resolves.toEqual({
      status: "found",
      bytes: new TextEncoder().encode(payload),
    });
    await expect(bindPayloadReader(store, B).readImmutable(read)).resolves.toEqual({
      status: "not_found",
    });
    await expect(store.readImmutable({ ...read, institutionId: B })).resolves.toEqual({
      status: "not_found",
    });
  });
});

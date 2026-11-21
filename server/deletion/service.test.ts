import { describe, expect, it } from "vitest";
import {
  createFakeSigner,
  createFakeStore,
  INSTITUTION_A,
  INSTITUTION_B,
  tombstone,
} from "./checkpoint.fixture.ts";
import { verifyErasureCheckpoint } from "./erasure-checkpoint.ts";
import { createDeletionService, ERASURE_CHECKPOINT_OBJECT_GROUP } from "./service.ts";

const RECORDS = [tombstone(11), tombstone(12), tombstone(13)];

async function setup() {
  const signer = createFakeSigner();
  const store = createFakeStore();
  return { signer, store, service: createDeletionService({ signer, store }) };
}

describe("DeletionService.checkpointErasures", () => {
  it("signs, self-checks and stores the checkpoint under the hash of its bytes", async () => {
    const { signer, store, service } = await setup();
    const result = await service.checkpointErasures({
      institutionId: INSTITUTION_A,
      records: RECORDS,
    });
    if (!result.ok) throw new Error(result.problem);
    const { bytes, sha256, storageRef, stored } = result.value;
    expect(stored).toBe("stored");
    expect(storageRef).toBe(
      `memory:v2/${INSTITUTION_A}/${ERASURE_CHECKPOINT_OBJECT_GROUP}/${sha256}.json`,
    );
    expect(store.objects.get(storageRef.slice("memory:".length))).toBe(
      new TextDecoder().decode(bytes),
    );
    const key = await signer.publicVerificationKey();
    if (!key.ok) throw new Error("fake signer has no key");
    expect(await verifyErasureCheckpoint(bytes, RECORDS, key.value)).toEqual({ ok: true });
  });

  it("stores the same bytes once for the same records", async () => {
    const { store, service } = await setup();
    const first = await service.checkpointErasures({
      institutionId: INSTITUTION_A,
      records: RECORDS,
    });
    const second = await service.checkpointErasures({
      institutionId: INSTITUTION_A,
      records: RECORDS.map((record) => ({ ...record })),
    });
    if (!first.ok || !second.ok) throw new Error("checkpoint failed");
    expect(second.value.bytes).toEqual(first.value.bytes);
    expect(second.value.stored).toBe("existing");
    expect(store.objects.size).toBe(1);
  });

  it("refuses bad input before anything is signed", async () => {
    const { signer, store, service } = await setup();
    expect(await service.checkpointErasures({ institutionId: "demo", records: RECORDS })).toEqual({
      ok: false,
      problem: "institution_invalid",
    });
    expect(
      await service.checkpointErasures({ institutionId: INSTITUTION_A, records: [{ id: 1 }] }),
    ).toEqual({
      ok: false,
      problem: "records_malformed",
    });
    expect(
      await service.checkpointErasures({
        institutionId: INSTITUTION_A,
        records: [tombstone(1, INSTITUTION_B)],
      }),
    ).toEqual({ ok: false, problem: "institution_mismatch" });
    expect(signer.calls).toBe(0);
    expect(store.objects.size).toBe(0);
  });

  it("stores nothing when the signer fails, is not Ed25519 or names another key", async () => {
    const store = createFakeStore();
    const good = createFakeSigner();
    const other = createFakeSigner();
    const failing = createDeletionService({
      signer: {
        ...good,
        sign: async () => ({ ok: false, error: { code: "KMS_UNAVAILABLE", messageKey: "x" } }),
      },
      store,
    });
    const ecdsa = createDeletionService({
      signer: {
        ...good,
        sign: async (message) => {
          const signed = await good.sign(message);
          return signed.ok
            ? { ok: true, value: { ...signed.value, algorithm: "ECDSA_P256_SHA256" } }
            : signed;
        },
      },
      store,
    });
    const mismatched = createDeletionService({
      signer: { sign: good.sign, publicVerificationKey: other.publicVerificationKey },
      store,
    });
    const input = { institutionId: INSTITUTION_A, records: RECORDS };
    expect(await failing.checkpointErasures(input)).toEqual({
      ok: false,
      problem: "signing_unavailable",
    });
    expect(await ecdsa.checkpointErasures(input)).toEqual({
      ok: false,
      problem: "signer_not_ed25519",
    });
    expect(await mismatched.checkpointErasures(input)).toEqual({
      ok: false,
      problem: "self_check_failed",
    });
    expect(store.objects.size).toBe(0);
  });

  it("maps each refusal of the store to a closed code", async () => {
    const { store, service } = await setup();
    const input = { institutionId: INSTITUTION_A, records: RECORDS };
    store.answer = { status: "conflict" };
    expect(await service.checkpointErasures(input)).toEqual({
      ok: false,
      problem: "storage_conflict",
    });
    store.answer = { status: "invalid" };
    expect(await service.checkpointErasures(input)).toEqual({
      ok: false,
      problem: "storage_invalid",
    });
    store.answer = { status: "unavailable", reason: "demo-bucket-down" };
    const answer = await service.checkpointErasures(input);
    expect(answer).toEqual({ ok: false, problem: "storage_unavailable" });
    expect(JSON.stringify(answer)).not.toContain("demo-bucket-down");
  });
});

import { describe, expect, it } from "vitest";
import { createFakeSigner, INSTITUTION_A, INSTITUTION_B, tombstone } from "./checkpoint.fixture.ts";
import {
  encodeErasureCheckpoint,
  ERASURE_CHAIN_GENESIS,
  erasureChainHead,
  erasureCheckpointPayload,
  erasureCheckpointSigningInput,
  readErasureTombstone,
  verifyErasureCheckpoint,
  type ErasureTombstone,
  type SignedErasureCheckpoint,
} from "./erasure-checkpoint.ts";

async function signedOver(
  records: ErasureTombstone[],
  signer?: ReturnType<typeof createFakeSigner>,
) {
  const key = signer ?? createFakeSigner();
  const payload = await erasureCheckpointPayload(INSTITUTION_A, records);
  const signature = await key.sign(erasureCheckpointSigningInput(payload));
  if (!signature.ok) throw new Error("fake signer failed");
  const publicKey = await key.publicVerificationKey();
  if (!publicKey.ok) throw new Error("fake signer has no key");
  const checkpoint: SignedErasureCheckpoint = { payload, signature: signature.value };
  return {
    checkpoint,
    bytes: encodeErasureCheckpoint(checkpoint),
    publicKey: publicKey.value,
    signer: key,
  };
}

const RECORDS = [tombstone(1), tombstone(2), tombstone(3), tombstone(4)];

describe("erasure checkpoint", () => {
  it("gives the same bytes for the same records", async () => {
    const signer = createFakeSigner();
    const first = await signedOver(RECORDS, signer);
    const second = await signedOver(
      RECORDS.map((record) => ({ ...record })),
      signer,
    );
    expect(second.bytes).toEqual(first.bytes);
    expect(first.checkpoint.payload).toMatchObject({
      recordCount: 4,
      lastRecordId: RECORDS[3]!.id,
    });
  });

  it("has the genesis head and no last record over no records", async () => {
    expect(await erasureChainHead([])).toBe(ERASURE_CHAIN_GENESIS);
    const { bytes, publicKey } = await signedOver([]);
    expect(await verifyErasureCheckpoint(bytes, [], publicKey)).toEqual({ ok: true });
  });

  it("verifies the stored bytes and the signed object", async () => {
    const { checkpoint, bytes, publicKey } = await signedOver(RECORDS);
    expect(await verifyErasureCheckpoint(bytes, RECORDS, publicKey)).toEqual({ ok: true });
    expect(await verifyErasureCheckpoint(checkpoint, RECORDS, publicKey)).toEqual({ ok: true });
  });

  it("fails a changed, removed, added or moved record", async () => {
    const { bytes, publicKey } = await signedOver(RECORDS);
    const changed = RECORDS.map((record, index) =>
      index === 2 ? { ...record, contentSha256: "f".repeat(64) } : record,
    );
    const moved = [RECORDS[1]!, RECORDS[0]!, RECORDS[2]!, RECORDS[3]!];
    const removed = [RECORDS[0]!, RECORDS[1]!, RECORDS[3]!];
    const added = [...RECORDS, tombstone(5)];
    expect(await verifyErasureCheckpoint(bytes, changed, publicKey)).toEqual({
      ok: false,
      problem: "chain_mismatch",
    });
    expect(await verifyErasureCheckpoint(bytes, moved, publicKey)).toEqual({
      ok: false,
      problem: "chain_mismatch",
    });
    expect(await verifyErasureCheckpoint(bytes, removed, publicKey)).toEqual({
      ok: false,
      problem: "count_mismatch",
    });
    expect(await verifyErasureCheckpoint(bytes, added, publicKey)).toEqual({
      ok: false,
      problem: "count_mismatch",
    });
  });

  it("fails a changed reason or time even when the hash of the content stays", async () => {
    const { bytes, publicKey } = await signedOver(RECORDS);
    const reason = RECORDS.map((record, index) =>
      index === 0
        ? {
            ...record,
            reason: record.reason === "retention_expired" ? "erasure_request" : "retention_expired",
          }
        : record,
    );
    const time = RECORDS.map((record, index) =>
      index === 3 ? { ...record, erasedAt: "2026-11-20T10:00:59.999999Z" } : record,
    );
    expect(await verifyErasureCheckpoint(bytes, reason, publicKey)).toEqual({
      ok: false,
      problem: "chain_mismatch",
    });
    expect(await verifyErasureCheckpoint(bytes, time, publicKey)).toEqual({
      ok: false,
      problem: "chain_mismatch",
    });
  });

  it("fails a record of another institution", async () => {
    const { bytes, publicKey } = await signedOver(RECORDS);
    const other = [...RECORDS.slice(0, 3), { ...RECORDS[3]!, institutionId: INSTITUTION_B }];
    expect(await verifyErasureCheckpoint(bytes, other, publicKey)).toEqual({
      ok: false,
      problem: "institution_mismatch",
    });
  });

  it("fails another key, a changed payload and a changed signature", async () => {
    const { checkpoint, bytes, publicKey } = await signedOver(RECORDS);
    const stranger = createFakeSigner();
    const strangerKey = await stranger.publicVerificationKey();
    if (!strangerKey.ok) throw new Error("fake signer has no key");
    expect(await verifyErasureCheckpoint(bytes, RECORDS, strangerKey.value)).toEqual({
      ok: false,
      problem: "signature_invalid",
    });
    expect(
      await verifyErasureCheckpoint(bytes, RECORDS, { ...publicKey, keyVersion: "v2" }),
    ).toEqual({
      ok: false,
      problem: "key_mismatch",
    });
    const forged = { ...checkpoint, payload: { ...checkpoint.payload, recordCount: 3 } };
    expect(await verifyErasureCheckpoint(forged, RECORDS.slice(0, 3), publicKey)).toEqual({
      ok: false,
      problem: "signature_invalid",
    });
    const last = checkpoint.signature.signatureBase64Url;
    const flipped = {
      ...checkpoint,
      signature: {
        ...checkpoint.signature,
        signatureBase64Url: `${last.slice(0, 10)}${last[10] === "A" ? "B" : "A"}${last.slice(11)}`,
      },
    };
    expect(await verifyErasureCheckpoint(flipped, RECORDS, publicKey)).toEqual({
      ok: false,
      problem: "signature_invalid",
    });
  });

  it("refuses bytes that are not the exact canonical form", async () => {
    const { checkpoint, bytes, publicKey } = await signedOver(RECORDS);
    const spaced = new TextEncoder().encode(JSON.stringify(checkpoint, null, 1));
    expect(await verifyErasureCheckpoint(spaced, RECORDS, publicKey)).toEqual({
      ok: false,
      problem: "checkpoint_malformed",
    });
    expect(await verifyErasureCheckpoint(bytes.slice(1), RECORDS, publicKey)).toEqual({
      ok: false,
      problem: "checkpoint_malformed",
    });
    expect(await verifyErasureCheckpoint({ ...checkpoint, extra: 1 }, RECORDS, publicKey)).toEqual({
      ok: false,
      problem: "checkpoint_malformed",
    });
  });

  it("refuses malformed records and keys without echoing them", async () => {
    const { bytes, publicKey } = await signedOver(RECORDS);
    const secret = "demo-tajna-vrijednost";
    const bad = [{ ...RECORDS[0]!, subjectId: ` ${secret}` }, ...RECORDS.slice(1)];
    const answer = await verifyErasureCheckpoint(bytes, bad, publicKey);
    expect(answer).toEqual({ ok: false, problem: "records_malformed" });
    expect(JSON.stringify(answer)).not.toContain(secret);
    expect(await verifyErasureCheckpoint(bytes, [RECORDS[0], RECORDS[0]], publicKey)).toMatchObject(
      {
        problem: "records_malformed",
      },
    );
    expect(await verifyErasureCheckpoint(bytes, "x", publicKey)).toMatchObject({
      problem: "records_malformed",
    });
    expect(
      await verifyErasureCheckpoint(bytes, RECORDS, { ...publicKey, keyBase64Url: secret }),
    ).toEqual({
      ok: false,
      problem: "key_invalid",
    });
  });

  it("refuses a key in a second base64url spelling of the same bytes", async () => {
    const { bytes, publicKey } = await signedOver(RECORDS);
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const text = publicKey.keyBase64Url;
    // The last character carries two unused bits; setting one keeps the bytes.
    const second = alphabet[alphabet.indexOf(text.at(-1)!) ^ 1]!;
    expect(
      await verifyErasureCheckpoint(bytes, RECORDS, {
        ...publicKey,
        keyBase64Url: text.slice(0, -1) + second,
      }),
    ).toEqual({
      ok: false,
      problem: "key_invalid",
    });
  });

  it("reads a tombstone only in the form evidence.erasure holds", () => {
    const record = tombstone(9);
    expect(readErasureTombstone(record)).toEqual(record);
    for (const broken of [
      { ...record, id: record.id.toUpperCase() },
      { ...record, dataClass: "document" },
      { ...record, reason: "other" },
      { ...record, contentSha256: "A".repeat(64) },
      { ...record, subjectId: "" },
      { ...record, subjectId: "a\u0007b" },
      { ...record, jobId: "not-a-uuid" },
      { ...record, erasedAt: "2026-11-20T10:00:00Z" },
      { ...record, erasedAt: "2026-02-30T10:00:00.000000Z" },
      { ...record, extra: true },
    ]) {
      expect(readErasureTombstone(broken)).toBeNull();
    }
  });
});

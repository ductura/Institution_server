// SRV-9B (✓ C-6): the public check over a fake read. The payload is invented
// and the key is the public RFC 8032 test vector 1, never a deployed key.
import { createPrivateKey, sign } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { WithActor } from "../database/index.ts";
import {
  digestSubmissionReceiptPayloadV2,
  type SubmissionReceiptPayloadV2,
} from "../domain/index.ts";

import { createPublicVerification } from "./index.ts";

const payload: SubmissionReceiptPayloadV2 = {
  receiptSchema: "ductus-submission-receipt-v2",
  signedAt: "2026-11-20T10:59:00.654321Z",
  submissionId: "c4a1e9d2-7b3f-4a65-8e0c-1f2d3b4c5a69",
  principalId: "72cd1705-85fc-4754-a382-c2500d038368",
  evidenceDomainId: "d21fe0a3-103c-42e5-a29e-c102f9030af5",
  assignmentId: "3b7e2f4a-9c1d-4e8b-a5f6-0d2c4b6a8e91",
  assignmentVersion: 1,
  documentId: "doc-1",
  evidencePackageId: "evidence-1",
  revision: 7,
  artifactSha256: "b".repeat(64),
  evidenceHeadSegmentHash: "a".repeat(64),
  evidenceRecord: "continuous",
  requestedAt: "2026-11-20T10:58:00.123456Z",
  dueAt: "2026-11-20T11:00:00.000000Z",
  afterDeadline: false,
};
const privateKey = createPrivateKey({
  key: Buffer.from(
    "302e020100300506032b6570042204209d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
    "hex",
  ),
  format: "der",
  type: "pkcs8",
});
const SPKI = Buffer.from(
  "302a300506032b6570032100d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
  "hex",
).toString("base64url");

/** The row the database gives for a match, signed over `signedPayload`. */
async function matchRow(signedPayload = payload, change: Record<string, unknown> = {}) {
  const digest = await digestSubmissionReceiptPayloadV2(signedPayload);
  const signature = sign(null, Buffer.from(digest.signingInput), privateKey);
  return {
    outcome: "match",
    payload: JSON.stringify(payload),
    digest: digest.sha256,
    signature: {
      algorithm: "Ed25519",
      keyId: "izmisljeni-kljuc",
      keyVersion: "1",
      signatureEncoding: "raw",
      signatureBase64Url: signature.toString("base64url"),
    },
    keyBase64Url: SPKI,
    domain: payload.evidenceDomainId,
    purpose: "receipt",
    validFrom: "2026-11-19T00:00:00.000Z",
    validTo: null,
    revokedAt: null,
    ...change,
  };
}

const NO_MATCH_ROW = {
  outcome: "no_match",
  ...Object.fromEntries(
    [
      "payload",
      "digest",
      "signature",
      "keyBase64Url",
      "domain",
      "purpose",
      "validFrom",
      "validTo",
      "revokedAt",
    ].map((name) => [name, null]),
  ),
};

/** A fake withActor answering `rows`, recording each token and query. */
function fakeDb(rows: unknown[] | Error) {
  const calls: {
    token: string | null | undefined;
    text: string;
    values: readonly unknown[] | undefined;
  }[] = [];
  const withActor: WithActor = async (token, fn) =>
    fn({
      query: async (text, values) => {
        calls.push({ token, text, values });
        if (rows instanceof Error) throw rows;
        return { rows: rows as never[], rowCount: rows.length };
      },
    });
  return { withActor, calls };
}

const verifyWith = (rows: unknown[] | Error) => {
  const db = fakeDb(rows);
  return { verify: createPublicVerification(db.withActor), calls: db.calls };
};

describe("public receipt verification", () => {
  it("answers match with only the two instants and the key id", async () => {
    const { verify, calls } = verifyWith([await matchRow()]);
    const result = await verify(payload.submissionId, payload.artifactSha256);
    expect(result).toEqual({
      status: "ok",
      answer: {
        match: true,
        submittedAt: payload.requestedAt,
        signedAt: payload.signedAt,
        keyId: "izmisljeni-kljuc",
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.token).toBeNull();
    expect(calls[0]?.values).toEqual([payload.submissionId, payload.artifactSha256]);
    expect(calls[0]?.text).toContain("app.public_receipt_verification($1::uuid, $2)");
  });

  it("answers match false for the database's no_match", async () => {
    const { verify } = verifyWith([NO_MATCH_ROW]);
    expect(await verify(payload.submissionId, payload.artifactSha256)).toEqual({
      status: "ok",
      answer: { match: false },
    });
  });

  it.each([
    ["an upper-case id", payload.submissionId.toUpperCase(), payload.artifactSha256],
    ["an upper-case hash", payload.submissionId, payload.artifactSha256.toUpperCase()],
    ["a short hash", payload.submissionId, "b".repeat(63)],
    ["an id that is no uuid", "not-a-uuid", payload.artifactSha256],
  ])("refuses %s without asking the database", async (_name, id, hash) => {
    const { verify, calls } = verifyWith([await matchRow()]);
    expect(await verify(id, hash)).toEqual({ status: "ok", answer: { match: false } });
    expect(calls).toHaveLength(0);
  });

  it("answers match false when the QR names another text than the receipt", async () => {
    const { verify } = verifyWith([await matchRow()]);
    expect(await verify(payload.submissionId, "c".repeat(64))).toEqual({
      status: "ok",
      answer: { match: false },
    });
  });

  it("answers match false when the QR names another submission than the receipt", async () => {
    const { verify } = verifyWith([await matchRow()]);
    const other = "d4a1e9d2-7b3f-4a65-8e0c-1f2d3b4c5a69";
    expect(await verify(other, payload.artifactSha256)).toEqual({
      status: "ok",
      answer: { match: false },
    });
  });

  it.each([
    ["a signature over another payload", async () => matchRow({ ...payload, revision: 8 })],
    ["a revoked key", async () => matchRow(payload, { revokedAt: "2026-11-20T11:30:00.000Z" })],
    [
      "a key valid only from after the signing",
      async () => matchRow(payload, { validFrom: "2026-11-20T11:00:00.000Z" }),
    ],
    ["a key of another purpose", async () => matchRow(payload, { purpose: "checkpoint" })],
    [
      "a key of another domain",
      async () => matchRow(payload, { domain: "e21fe0a3-103c-42e5-a29e-c102f9030af5" }),
    ],
    ["a stored digest of other bytes", async () => matchRow(payload, { digest: "0".repeat(64) })],
    ["a payload that is not JSON", async () => matchRow(payload, { payload: "{" })],
    [
      "a payload of another form",
      async () => matchRow(payload, { payload: JSON.stringify({ ...payload, x: 1 }) }),
    ],
    ["no signature", async () => matchRow(payload, { signature: null })],
  ])("answers match false for %s", async (_name, row) => {
    const { verify } = verifyWith([await row()]);
    expect(await verify(payload.submissionId, payload.artifactSha256)).toEqual({
      status: "ok",
      answer: { match: false },
    });
  });

  it.each([
    ["a database error", new Error("connection refused")],
    ["no row", []],
    ["two rows", [NO_MATCH_ROW, NO_MATCH_ROW]],
    ["an unknown outcome", [{ ...NO_MATCH_ROW, outcome: "maybe" }]],
  ])("is unavailable for %s", async (_name, rows) => {
    const { verify } = verifyWith(rows);
    expect(await verify(payload.submissionId, payload.artifactSha256)).toEqual({
      status: "unavailable",
    });
  });
});

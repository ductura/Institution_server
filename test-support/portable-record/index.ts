// Invented data for the tests of the portable record (SRV-1312) and of the CLI
// scripts/evidence-verify: two invented students, an invented text, a receipt
// signed with the public RFC 8032 test vector 1 key (never a deployed key) and
// a reader of the stored ZIP the builder writes. No real person, work or key.
import { createHash, createPrivateKey, sign } from "node:crypto";

import type { PortableRecordSource, renderReceiptPdf } from "../../server/downloads/index.ts";
import {
  canonicalizeJcs,
  digestSubmissionReceiptPayloadV2,
  type SubmissionReceiptPayloadV2,
} from "../../server/domain/index.ts";

const sha256Hex = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

type ReceiptPdfLabels = Parameters<typeof renderReceiptPdf>[2];

export const ORIGIN = "https://ductura.invalid";

/** Two invented students; only their ids reach a receipt. */
export const STUDENT_A = {
  id: "72cd1705-85fc-4754-a382-c2500d038368",
  name: "Ivana Izmisljena",
  email: "ivana.izmisljena@student.ductura.invalid",
} as const;
export const STUDENT_B = {
  id: "5a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
  name: "Petar Primjeric",
  email: "petar.primjeric@student.ductura.invalid",
} as const;

export const SUBMISSION_ID = "c4a1e9d2-7b3f-4a65-8e0c-1f2d3b4c5a69";
export const SENTENCE = "Invented text: home composting reduces waste in an invented town.";

/** The submitted text: the JCS of an invented document, as a checkpoint stores it. */
export const TEXT = canonicalizeJcs({
  content: [{ text: SENTENCE, type: "paragraph" }],
  schemaVersion: 2,
});

export const PAYLOAD: SubmissionReceiptPayloadV2 = {
  receiptSchema: "ductus-submission-receipt-v2",
  submissionId: SUBMISSION_ID,
  evidenceDomainId: "d21fe0a3-103c-42e5-a29e-c102f9030af5",
  principalId: STUDENT_A.id,
  assignmentId: "3b7e2f4a-9c1d-4e8b-a5f6-0d2c4b6a8e91",
  assignmentVersion: 1,
  documentId: "rad-izmisljeni-1",
  evidencePackageId: "paket-izmisljeni-1",
  revision: 7,
  artifactSha256: sha256Hex(new TextEncoder().encode(TEXT)),
  evidenceHeadSegmentHash: "a".repeat(64),
  evidenceRecord: "continuous",
  requestedAt: "2026-11-20T10:58:00.123456Z",
  dueAt: "2026-11-20T11:00:00.000000Z",
  afterDeadline: false,
  signedAt: "2026-11-20T10:59:00.654321Z",
};

const PRIVATE_KEY = createPrivateKey({
  key: Buffer.from(
    "302e020100300506032b6570042204209d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
    "hex",
  ),
  format: "der",
  type: "pkcs8",
});

export const RECEIPT_KEY = {
  algorithm: "Ed25519",
  keyId: "izmisljeni-kljuc",
  keyVersion: "1",
  encoding: "spki-der",
  keyBase64Url: Buffer.from(
    "302a300506032b6570032100d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
    "hex",
  ).toString("base64url"),
  evidenceDomainId: PAYLOAD.evidenceDomainId,
  purpose: "receipt",
  validFrom: "2026-11-19T00:00:00.000Z",
  validTo: null,
  revokedAt: null,
} as const;

/** The rows of one submission as the database adapter gives them. */
export async function sourceOf(payload = PAYLOAD, text = TEXT): Promise<PortableRecordSource> {
  const digest = await digestSubmissionReceiptPayloadV2(payload);
  return {
    receiptPayload: digest.canonical,
    payloadDigestSha256: digest.sha256,
    signature: {
      algorithm: "Ed25519",
      keyId: RECEIPT_KEY.keyId,
      keyVersion: RECEIPT_KEY.keyVersion,
      signatureEncoding: "raw",
      signatureBase64Url: sign(null, Buffer.from(digest.signingInput), PRIVATE_KEY).toString(
        "base64url",
      ),
    },
    key: { ...RECEIPT_KEY },
    text,
  };
}

export const LABELS: ReceiptPdfLabels = {
  title: "Potvrda predaje",
  submissionId: "Predaja",
  assignmentId: "Zadatak",
  assignmentVersion: "Inacica zadatka",
  revision: "Inacica rada",
  requestedAt: "Zatrazeno",
  signedAt: "Potpisano",
  dueAt: "Rok",
  onTime: "on-time",
  afterDeadline: "after-deadline",
  artifactSha256: "Otisak rada (SHA-256)",
  verification: "Provjera",
  scan: "scan",
};

/** The files of a ZIP of stored entries (method 0), by name; throws on anything else. */
export function unzipStored(zip: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const files = new Map<string, Uint8Array>();
  let at = 0;
  while (view.getUint32(at, true) === 0x04034b50) {
    if (view.getUint16(at + 8, true) !== 0) throw new Error("not a stored entry");
    const size = view.getUint32(at + 18, true);
    const nameLength = view.getUint16(at + 26, true);
    const extra = view.getUint16(at + 28, true);
    const name = Buffer.from(zip.subarray(at + 30, at + 30 + nameLength)).toString("utf8");
    const start = at + 30 + nameLength + extra;
    files.set(name, zip.slice(start, start + size));
    at = start + size;
  }
  return files;
}

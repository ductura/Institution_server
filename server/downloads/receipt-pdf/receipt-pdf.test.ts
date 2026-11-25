import { createHash } from "node:crypto";

import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";

import { receiptPdfHr } from "../../../locales/index.ts";
import {
  digestSubmissionReceiptPayloadV2,
  type SignedSubmissionReceiptV2,
} from "../../domain/index.ts";

import { renderReceiptPdf, verificationUrl } from "./receipt-pdf.ts";

const ORIGIN = "https://demo-fakultet.invalid";
const PAYLOAD = {
  receiptSchema: "ductus-submission-receipt-v2",
  submissionId: "00000000-0000-4000-8000-000000000001",
  assignmentId: "00000000-0000-4000-8000-000000000002",
  principalId: "00000000-0000-4000-8000-000000000003",
  evidenceDomainId: "00000000-0000-4000-8000-000000000004",
  assignmentVersion: 2,
  documentId: "demo-rad",
  evidencePackageId: "demo-paket",
  revision: 7,
  artifactSha256: "ab".repeat(32),
  evidenceHeadSegmentHash: "cd".repeat(32),
  evidenceRecord: "continuous",
  requestedAt: "2026-11-20T10:00:00.123456Z",
  signedAt: "2026-11-20T10:00:01.654321Z",
  dueAt: "2026-11-20T11:00:00.000000Z",
  afterDeadline: false,
} as const;

async function receipt(
  artifactSha256 = PAYLOAD.artifactSha256,
): Promise<SignedSubmissionReceiptV2> {
  const payload = { ...PAYLOAD, artifactSha256 };
  return {
    payload,
    payloadDigestSha256: (await digestSubmissionReceiptPayloadV2(payload)).sha256,
    signature: {
      algorithm: "Ed25519",
      keyId: "demo-kljuc",
      keyVersion: "1",
      signatureEncoding: "raw",
      signatureBase64Url: Buffer.alloc(64).toString("base64url"),
    },
  };
}

describe("receipt PDF", () => {
  it("uses the public page and sends the receipt id and document hash only in the fragment", () => {
    const url = new URL(verificationUrl(ORIGIN, PAYLOAD));
    expect(url.origin).toBe(ORIGIN);
    expect(url.pathname).toBe("/provjera");
    expect(url.search).toBe("");
    expect(url.hash).toBe(`#r=${PAYLOAD.submissionId}&o=${PAYLOAD.artifactSha256}`);
  });

  it("accepts the configured local origin", () => {
    expect(verificationUrl("http://localhost:3000", PAYLOAD)).toMatch(
      /^http:\/\/localhost:3000\/provjera#/,
    );
  });

  it.each([
    "",
    "https://demo-fakultet.invalid/podstranica",
    "https://demo-fakultet.invalid?x=1",
    "https://demo-fakultet.invalid#x",
    "https://demo:demo@demo-fakultet.invalid",
    "file:///provjera",
  ])("refuses a configured address that is not an HTTP origin (%s)", (origin) => {
    expect(() => verificationUrl(origin, PAYLOAD)).toThrow();
  });

  it("renders the same single-page PDF every time and changes it for a different work hash", async () => {
    const signed = await receipt();
    const bytes = await renderReceiptPdf(signed, ORIGIN, receiptPdfHr);
    const document = await PDFDocument.load(bytes, { updateMetadata: false });
    expect(document.getPageCount()).toBe(1);
    expect(document.getTitle()).toBe(receiptPdfHr.title);
    expect(await renderReceiptPdf(signed, ORIGIN, receiptPdfHr)).toEqual(bytes);
    expect(
      await renderReceiptPdf(await receipt("ef".repeat(32)), ORIGIN, receiptPdfHr),
    ).not.toEqual(bytes);
    expect(createHash("sha256").update(bytes).digest("hex")).toMatchInlineSnapshot(
      `"15e2b2e6e6e39cf8dd20b043a443e20ae128fe4a8b0181a3a407747d40ba54fc"`,
    );
  });
});

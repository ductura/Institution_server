import { createHash } from "node:crypto";

import { inflateSync } from "node:zlib";

import { PDFDocument } from "pdf-lib";
import { getDocumentProxy } from "unpdf";
import { encode } from "uqr";
import { describe, expect, it } from "vitest";

import { receiptPdfHr } from "../../../locales/index.ts";
import {
  digestSubmissionReceiptPayloadV2,
  type SignedSubmissionReceiptV2,
} from "../../domain/index.ts";

import { confirmationCodeUrl, renderReceiptPdf, verificationUrl } from "./receipt-pdf.ts";

/** An invented confirmation code of the bound receipt (Crockford, uppercase). */
const CODE = "DK7M-4Q9P-X2HT-R8VN";

/** The dark modules the PDF draws, from its inflated content streams, in drawing order. */
function drawnSquares(pdf: Uint8Array): string[] {
  const text = Buffer.from(pdf).toString("latin1");
  const squares: string[] = [];
  for (const match of text.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    let body: string;
    try {
      body = inflateSync(Buffer.from(match[1]!, "latin1")).toString("latin1");
    } catch {
      body = match[1]!;
    }
    // @cantoo/pdf-lib moves to the top-left corner, flips the y axis and draws the
    // whole path; the module's bottom-left corner is then y minus the path height.
    const flipped =
      /1 0 0 1 (-?[\d.]+) (-?[\d.]+) cm\n1 0 0 1 0 0 cm\n1 0 0 1 0 0 cm\n1 0 0 -1 0 0 cm\n0 0 0 rg\n\[\] 0 d\n0 0 m\n([\d.]+) 0 l\n\3 ([\d.]+) l\n0 \4 l\nh\nf\n/g;
    for (const op of body.matchAll(flipped)) {
      squares.push(`${Number(op[1]).toFixed(2)},${(Number(op[2]) - Number(op[4])).toFixed(2)}`);
    }
  }
  return squares;
}

/** The squares the receipt draws for the QR of `url` (45, 117, 156 pt). */
function qrSquares(url: string): string[] {
  const { data, size } = encode(url, { border: 4, ecc: "M" });
  const unit = 156 / size;
  const squares: string[] = [];
  data.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (dark)
        squares.push(`${(45 + x * unit).toFixed(2)},${(117 + (size - 1 - y) * unit).toFixed(2)}`);
    }),
  );
  return squares;
}

/** Each shown string of the page with its baseline position. */
async function shownText(pdf: Uint8Array): Promise<{ str: string; x: number; y: number }[]> {
  const page = await (await getDocumentProxy(Uint8Array.from(pdf))).getPage(1);
  return (await page.getTextContent()).items.flatMap((item) =>
    "str" in item && item.str !== ""
      ? [{ str: item.str, x: item.transform[4] as number, y: item.transform[5] as number }]
      : [],
  );
}

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

  it("opens the check by the confirmation code, with the uppercase code only in the fragment", () => {
    const url = new URL(confirmationCodeUrl(ORIGIN, CODE));
    expect(url.href).toBe(`${ORIGIN}/provjera#k=${CODE}`);
    expect(url.search).toBe("");
    expect(url.hash).toBe(`#k=${CODE}`);
    expect(confirmationCodeUrl("http://localhost:3000", CODE)).toBe(
      `http://localhost:3000/provjera#k=${CODE}`,
    );
  });

  it.each([
    CODE.toLowerCase(),
    "DK7M4Q9PX2HTR8VN",
    "DK7M-4Q9P-X2HT-R8V",
    "DK7M-4Q9P-X2HT-R8VU",
    `${CODE}&r=x`,
    "",
  ])("refuses a value that is not a confirmation code (%s)", (code) => {
    expect(() => confirmationCodeUrl(ORIGIN, code)).toThrow();
  });

  it("refuses a configured address that is not an HTTP origin for the code too", () => {
    expect(() => confirmationCodeUrl("https://demo-fakultet.invalid/podstranica", CODE)).toThrow();
  });

  it("draws the QR of the code check and prints the code under it", async () => {
    const signed = await receipt();
    const pdf = await renderReceiptPdf(signed, ORIGIN, receiptPdfHr, CODE);
    expect(drawnSquares(pdf)).toEqual(qrSquares(`${ORIGIN}/provjera#k=${CODE}`));
    const shown = await shownText(pdf);
    const code = shown.filter(({ str }) => str === CODE);
    expect(code).toHaveLength(1);
    // Under the QR's 156 pt square at (45, 117), left-aligned with the other text.
    expect(code[0]!.y).toBeLessThan(117);
    expect(code[0]!.x).toBe(54);
    expect(await renderReceiptPdf(signed, ORIGIN, receiptPdfHr, CODE)).toEqual(pdf);
  });

  it("keeps the receipt without a bound code as it was: no code, the QR of the pair", async () => {
    const signed = await receipt();
    const pdf = await renderReceiptPdf(signed, ORIGIN, receiptPdfHr, null);
    expect(pdf).toEqual(await renderReceiptPdf(signed, ORIGIN, receiptPdfHr));
    expect(drawnSquares(pdf)).toEqual(qrSquares(verificationUrl(ORIGIN, PAYLOAD)));
    expect(drawnSquares(pdf)).not.toEqual(qrSquares(`${ORIGIN}/provjera#k=${CODE}`));
    const shown = await shownText(pdf);
    expect(shown.filter(({ y }) => y < 117)).toEqual([]);
    expect(
      shown.some(({ str }) => /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/.test(str)),
    ).toBe(false);
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

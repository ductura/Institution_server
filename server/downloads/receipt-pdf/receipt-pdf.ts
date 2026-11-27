import fontkit from "@cantoo/fontkit";
import { PageSizes, PDFDocument, rgb, type PDFPage } from "@cantoo/pdf-lib";
import { encode } from "uqr";

import type { SignedSubmissionReceiptV2, SubmissionReceiptPayloadV2 } from "../../domain/index.ts";

import { RECEIPT_FONT_BASE64 } from "./receipt-font.ts";

export type ReceiptPdfLabels = Readonly<{
  title: string;
  submissionId: string;
  assignmentId: string;
  assignmentVersion: string;
  revision: string;
  requestedAt: string;
  signedAt: string;
  dueAt: string;
  onTime: string;
  afterDeadline: string;
  artifactSha256: string;
  verification: string;
  scan: string;
}>;

const MARGIN = 54;
const GRAPHITE = rgb(0.12, 0.12, 0.12);
const SECONDARY = rgb(0.3, 0.3, 0.3);
const BLACK = rgb(0, 0, 0);
const FONT_BYTES = Buffer.from(RECEIPT_FONT_BASE64, "base64");
/** The confirmation code: Crockford base32 without I, L, O and U, 4 groups of 4, uppercase. */
const CONFIRMATION_CODE = /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/;

function httpOrigin(origin: string): URL {
  const base = new URL(origin);
  if (base.origin !== origin || (base.protocol !== "https:" && base.protocol !== "http:")) {
    throw new Error("receipt PDF requires a configured HTTP origin");
  }
  return base;
}

/** C-6: private receipt lookup values stay in the fragment. */
export function verificationUrl(
  origin: string,
  payload: Pick<SubmissionReceiptPayloadV2, "submissionId" | "artifactSha256">,
): string {
  const url = new URL("/provjera", httpOrigin(origin));
  url.hash = new URLSearchParams({ r: payload.submissionId, o: payload.artifactSha256 }).toString();
  return url.href;
}

/**
 * Dizajn 1.1, korak 4: the public check by the confirmation code. The code stays
 * in the fragment, so it never reaches a request line or a server log.
 */
export function confirmationCodeUrl(origin: string, code: string): string {
  if (!CONFIRMATION_CODE.test(code)) throw new Error("receipt PDF requires a confirmation code");
  return `${new URL("/provjera", httpOrigin(origin)).href}#k=${code}`;
}

function drawQr(page: PDFPage, url: string, x: number, y: number): void {
  const { data, size } = encode(url, { border: 4, ecc: "M" });
  const unit = 156 / size;
  data.forEach((row, rowIndex) =>
    row.forEach((dark, columnIndex) => {
      if (!dark) return;
      page.drawRectangle({
        x: x + columnIndex * unit,
        y: y + (size - 1 - rowIndex) * unit,
        width: unit,
        height: unit,
        color: BLACK,
      });
    }),
  );
}

/**
 * Render the same bytes for the same stored receipt, origin, labels and code.
 * With the bound confirmation code the QR opens the check by that code and the
 * code is printed under it (Dizajn 1.1, koraci 4 do 6); without one (a receipt
 * from before the codes) the page is exactly as before.
 */
export async function renderReceiptPdf(
  receipt: SignedSubmissionReceiptV2,
  origin: string,
  labels: ReceiptPdfLabels,
  confirmationCode: string | null = null,
): Promise<Uint8Array> {
  const { payload } = receipt;
  const url =
    confirmationCode === null
      ? verificationUrl(origin, payload)
      : confirmationCodeUrl(origin, confirmationCode);
  const pdf = await PDFDocument.create({ updateMetadata: false });
  pdf.registerFontkit(fontkit);
  pdf.setTitle(labels.title);
  const font = await pdf.embedFont(FONT_BYTES, { subset: true });
  const page = pdf.addPage(PageSizes.A4);

  const text = (value: string, y: number, size: number, color = GRAPHITE) =>
    page.drawText(value, { x: MARGIN, y, size, font, color });
  text(labels.title, 757, 27);
  text(payload.afterDeadline ? labels.afterDeadline : labels.onTime, 728, 12);

  const fields = [
    [labels.submissionId, payload.submissionId],
    [labels.assignmentId, payload.assignmentId],
    [labels.assignmentVersion, String(payload.assignmentVersion)],
    [labels.revision, String(payload.revision)],
    [labels.requestedAt, payload.requestedAt],
    [labels.signedAt, payload.signedAt],
    [labels.dueAt, payload.dueAt],
    [labels.artifactSha256, payload.artifactSha256],
  ] as const;
  fields.forEach(([label, value], index) => {
    const y = 681 - index * 43;
    text(label, y, 10, SECONDARY);
    text(value, y - 16, 11);
  });

  text(labels.verification, 310, 15);
  text(labels.scan, 287, 11);
  drawQr(page, url, MARGIN - 9, 117);
  if (confirmationCode !== null) text(confirmationCode, 100, 14);

  return pdf.save();
}

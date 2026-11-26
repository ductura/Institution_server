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

/** C-6: private receipt lookup values stay in the fragment. */
export function verificationUrl(
  origin: string,
  payload: Pick<SubmissionReceiptPayloadV2, "submissionId" | "artifactSha256">,
): string {
  const base = new URL(origin);
  if (base.origin !== origin || (base.protocol !== "https:" && base.protocol !== "http:")) {
    throw new Error("receipt PDF requires a configured HTTP origin");
  }
  const url = new URL("/provjera", base);
  url.hash = new URLSearchParams({ r: payload.submissionId, o: payload.artifactSha256 }).toString();
  return url.href;
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

/** Render the same bytes for the same stored receipt, origin and labels. */
export async function renderReceiptPdf(
  receipt: SignedSubmissionReceiptV2,
  origin: string,
  labels: ReceiptPdfLabels,
): Promise<Uint8Array> {
  const { payload } = receipt;
  const url = verificationUrl(origin, payload);
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

  return pdf.save();
}

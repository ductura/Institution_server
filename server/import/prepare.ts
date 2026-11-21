// One entry for both import formats (SRV-1803, SRV-1804): the format is the
// file's own, read from its first bytes, never from the name or the client.
// `%PDF-` in the first KiB is a PDF; anything else goes to the DOCX reader,
// which refuses what it is not.
import type { ImportReadLimitsV1 } from "../contracts/index.ts";

import { prepareDocxImport, type DocxImportPreview } from "./docx/index.ts";
import { preparePdfImport, type PdfImportPreview } from "./pdf/index.ts";

export type ImportPreview =
  | (DocxImportPreview & { readonly fileFormat: "docx" })
  | (PdfImportPreview & { readonly fileFormat: "pdf" });

export type ImportPrepared =
  | { readonly ok: true; readonly preview: ImportPreview }
  | {
      readonly ok: false;
      readonly code: Extract<Awaited<ReturnType<typeof preparePdfImport>>, { ok: false }>["code"];
    };

const isPdf = (bytes: Uint8Array) =>
  Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.length, 1024))
    .toString("latin1")
    .includes("%PDF-");

export async function prepareImport(input: {
  readonly bytes: Uint8Array;
  readonly documentId: string;
  readonly fileName: string | null;
  readonly limits: ImportReadLimitsV1;
  readonly importId?: string;
  readonly uuid?: () => string;
}): Promise<ImportPrepared> {
  if (isPdf(input.bytes)) {
    const pdf = await preparePdfImport(input);
    return pdf.ok ? { ok: true, preview: { ...pdf.preview, fileFormat: "pdf" } } : pdf;
  }
  const docx = prepareDocxImport(input);
  return docx.ok ? { ok: true, preview: { ...docx.preview, fileFormat: "docx" } } : docx;
}

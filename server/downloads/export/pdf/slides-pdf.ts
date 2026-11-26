// The slides export of one stored version (SRV-V13-RUTA-IZVOZ, val 13): the
// .pptx of server/downloads/export/pptx.ts as it is, or a PDF made from exactly
// that .pptx by the same local LibreOffice (Gotenberg on a loopback address) the
// DOCX export uses, so no new network dependency. A PDF is never marked PDF/A
// here: the mark needs the veraPDF confirmation of the exact bytes, and no
// verifier is wired for slides, so the converter is asked for a plain PDF only.
// Conversion timeout and conversion failure are separate states, and so is a
// missing converter; the HTTP edge turns all of them into one 503 and records
// the closed reason. No clock and no I/O except the one call to the converter.
import { randomUUID } from "node:crypto";

import { SLIDES_DOCUMENT_KIND } from "../../../domain/index.ts";
import { renderSlidesPptx, type SlidesPptx } from "../pptx.ts";
import type { SlidesExportLabels } from "../slides-model.ts";

export const PPTX_TYPE =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";

export type SlidesExportFormat = "pptx" | "pdf";

/** The .pptx bytes in, the PDF bytes out; it rejects on a timeout or any failure. */
export type ConvertPptx = (pptx: Buffer) => Promise<Buffer>;

const MAX_PDF_BYTES = 16 * 1024 * 1024;
const CONVERT_TIMEOUT_MS = 30_000;
const LOOPBACK = /^http:\/\/(?:127\.0\.0\.1|\[::1\]):[1-9][0-9]{0,4}$/u;

/** The deployment supplies a local Gotenberg endpoint with LibreOffice isolated from egress. */
export function localSlidesPdfConverter(
  origin: string | undefined,
  options: { readonly timeoutMs?: number } = {},
): ConvertPptx | undefined {
  if (origin === undefined || !LOOPBACK.test(origin)) return undefined;
  const url = URL.parse(`${origin}/forms/libreoffice/convert`);
  if (url === null) return undefined;
  const timeoutMs = options.timeoutMs ?? CONVERT_TIMEOUT_MS;
  return async (pptx) => {
    const boundary = randomUUID();
    const prefix = `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="work.pptx"\r\nContent-Type: ${PPTX_TYPE}\r\n\r\n`;
    const body = Buffer.concat([Buffer.from(prefix), pptx, Buffer.from(`\r\n--${boundary}--\r\n`)]);
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      body: new Uint8Array(body),
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (
      !response.ok ||
      response.body === null ||
      response.headers.get("content-type") !== "application/pdf"
    ) {
      await response.body?.cancel();
      throw new Error("PDF conversion failed");
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_PDF_BYTES) {
        await reader.cancel();
        throw new Error("PDF conversion returned too many bytes");
      }
      chunks.push(value);
    }
    const pdf = Buffer.concat(chunks, size);
    if (pdf.subarray(0, 5).toString("ascii") !== "%PDF-")
      throw new Error("PDF conversion returned no PDF");
    return pdf;
  };
}

/** What the stored text of a revision is for the slides export. */
export type SlidesBodyKind =
  /** Valid JSON of another kind (a text work, a spreadsheet): it has no slides export (404). */
  | { readonly kind: "not_slides" }
  /** Declares itself as slides but is not JSON or not an object. */
  | { readonly kind: "unreadable"; readonly reason: "body_not_json" }
  | { readonly kind: "slides"; readonly attachmentIds: readonly string[] };

/**
 * Names the kind of the stored text and, for slides, the attachments its image
 * blocks bind, in order of first use. The document itself is validated later
 * by the .pptx writer; this only decides the 404 and which images to fetch.
 */
export function slidesBodyKind(body: string): SlidesBodyKind {
  let stored: unknown;
  try {
    stored = JSON.parse(body);
  } catch {
    return { kind: "unreadable", reason: "body_not_json" };
  }
  if (typeof stored !== "object" || stored === null || Array.isArray(stored))
    return { kind: "not_slides" };
  if ((stored as { documentKind?: unknown }).documentKind !== SLIDES_DOCUMENT_KIND)
    return { kind: "not_slides" };
  const ids = new Set<string>();
  const slides = (stored as { slides?: unknown }).slides;
  if (Array.isArray(slides)) {
    for (const slide of slides) {
      const blocks = (slide as { blocks?: unknown } | null)?.blocks;
      if (!Array.isArray(blocks)) continue;
      for (const block of blocks) {
        const b = block as { type?: unknown; attachmentId?: unknown } | null;
        if (b?.type === "image" && typeof b.attachmentId === "string") ids.add(b.attachmentId);
      }
    }
  }
  return { kind: "slides", attachmentIds: [...ids] };
}

export type SlidesExportInput = {
  /** The exact stored bytes of the text of the revision. */
  readonly body: string;
  /** Stored image bytes by attachment id; each is checked against the SHA-256 in the document. */
  readonly images: ReadonlyMap<string, Uint8Array>;
  readonly labels: SlidesExportLabels;
  readonly format: SlidesExportFormat;
  /** Absent when the deployment has no local converter; a PDF is then unavailable. */
  readonly convert: ConvertPptx | undefined;
};

export type SlidesExport =
  | {
      readonly status: "rendered";
      readonly format: SlidesExportFormat;
      readonly bytes: Uint8Array;
      /** SHA-256 of the frozen snapshot, lowercase hex: the same for the .pptx and the PDF of a version. */
      readonly snapshotSha256: string;
    }
  | { readonly status: "not_slides" }
  | Exclude<SlidesPptx, { readonly status: "rendered" }>
  | { readonly status: "unreadable"; readonly reason: "body_not_json" }
  /** A PDF was asked for and the deployment has no local converter. */
  | { readonly status: "pdf_unavailable" }
  /** The converter did not answer within its time limit. */
  | { readonly status: "pdf_timeout" }
  /** The converter refused or returned something that is not a PDF. */
  | { readonly status: "pdf_failed" };

function isTimeout(thrown: unknown): boolean {
  try {
    return (
      typeof thrown === "object" &&
      thrown !== null &&
      "name" in thrown &&
      (thrown.name === "TimeoutError" || thrown.name === "AbortError")
    );
  } catch {
    return false;
  }
}

export async function renderSlidesExport(input: SlidesExportInput): Promise<SlidesExport> {
  const kind = slidesBodyKind(input.body);
  if (kind.kind === "not_slides") return { status: "not_slides" };
  if (kind.kind === "unreadable") return { status: "unreadable", reason: kind.reason };
  if (input.format === "pdf" && input.convert === undefined) return { status: "pdf_unavailable" };
  const pptx = renderSlidesPptx({
    snapshot: Buffer.from(input.body, "utf8"),
    images: input.images,
    labels: input.labels,
  });
  if (pptx.status !== "rendered") return pptx;
  if (input.format === "pptx") {
    return {
      status: "rendered",
      format: "pptx",
      bytes: pptx.bytes,
      snapshotSha256: pptx.snapshotSha256,
    };
  }
  try {
    const pdf = await input.convert!(Buffer.from(pptx.bytes));
    if (pdf.subarray(0, 5).toString("ascii") !== "%PDF-") return { status: "pdf_failed" };
    return {
      status: "rendered",
      format: "pdf",
      bytes: pdf,
      snapshotSha256: pptx.snapshotSha256,
    };
  } catch (thrown) {
    return { status: isTimeout(thrown) ? "pdf_timeout" : "pdf_failed" };
  }
}

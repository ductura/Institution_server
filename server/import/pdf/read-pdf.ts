// Reads a received PDF into a Ductura document v2 (SRV-1804, M8.3; ADR
// docs/adr/import-contract.md §4 and attack rows D1 to D5). Only the text
// layer is taken, through PDF.js with scripts, fonts and XFA turned off;
// nothing from the file is run or fetched. The order is fixed: size, format,
// the structural scan (D2, D3), the page count (D1), the text, then the
// content bound of a segment (L2). A PDF without text (a scan) is refused
// with PDF_NO_TEXT_LAYER (D5), never guessed at. Any failure inside PDF.js is
// PDF_INVALID (D4) and its message never leaves this function.
import { getDocument } from "pdfjs-dist";

import {
  canonicalizeJcs,
  MAX_EVIDENCE_SEGMENT_BYTES,
  newNodeId,
  validateVersionedDocument,
  type CanonicalDocumentV2,
  type DocumentNodeV2,
} from "../../domain/index.ts";
import type { ImportReadLimitsV1, ImportReadRejectCode } from "../../contracts/index.ts";
import { cleanText } from "../docx/index.ts";

import { scanPdf } from "./scan.ts";

export type PdfRead =
  | {
      readonly ok: true;
      readonly content: CanonicalDocumentV2;
      /** JCS of the content: the text whose SHA-256 is `contentSha256`. */
      readonly contentCanonical: string;
    }
  | { readonly ok: false; readonly code: ImportReadRejectCode };

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-

/** A gap between two lines wider than this many font sizes starts a new paragraph. */
const PARAGRAPH_GAP = 1.5;

type Line = { readonly text: string; readonly y: number; readonly size: number };
type Failure = { readonly ok: false; readonly code: ImportReadRejectCode };

export async function readPdf(
  bytes: Uint8Array,
  limits: ImportReadLimitsV1,
  uuid?: () => string,
): Promise<PdfRead> {
  if (bytes.length === 0) return { ok: false, code: "FILE_EMPTY" };
  if (bytes.length > limits.maxInputBytes) return { ok: false, code: "FILE_TOO_LARGE" };
  if (!PDF_MAGIC.every((byte, i) => bytes[i] === byte)) {
    return { ok: false, code: "FORMAT_NOT_ALLOWED" };
  }
  const scan = await scanPdf(bytes);
  if (!scan.ok) return scan;
  let paragraphs: string[] | Failure;
  try {
    paragraphs = await extractParagraphs(bytes, limits);
  } catch {
    return { ok: false, code: "PDF_INVALID" };
  }
  if (!Array.isArray(paragraphs)) return paragraphs;
  // D5: no text at all is a scan; the student is asked for a file with text.
  if (paragraphs.length === 0) return { ok: false, code: "PDF_NO_TEXT_LAYER" };
  const nodes: DocumentNodeV2[] = paragraphs.map((text) => ({
    type: "paragraph",
    id: newNodeId(uuid),
    children: [{ type: "text", text, marks: [] }],
  }));
  const content: CanonicalDocumentV2 = { schemaVersion: 2, nodes, sources: [] };
  // The reader only builds what document v2 takes; a refusal here is a bug, read as a broken file.
  if (!validateVersionedDocument(content).ok) return { ok: false, code: "PDF_INVALID" };
  const contentCanonical = canonicalizeJcs(content);
  // L2: too much text for one segment is refused, never cut.
  if (Buffer.byteLength(contentCanonical, "utf8") > MAX_EVIDENCE_SEGMENT_BYTES) {
    return { ok: false, code: "CONTENT_TOO_LARGE" };
  }
  return { ok: true, content, contentCanonical };
}

async function extractParagraphs(
  bytes: Uint8Array,
  limits: ImportReadLimitsV1,
): Promise<string[] | Failure> {
  // PDF.js may detach the buffer it is given; the caller's bytes stay whole.
  const task = getDocument({
    data: new Uint8Array(bytes),
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    enableXfa: false,
    stopAtErrors: true,
    verbosity: 0,
  });
  try {
    const doc = await task.promise;
    // D1: the page count is known before any page is read.
    if (doc.numPages > limits.maxPdfPages) return { ok: false, code: "PDF_TOO_MANY_PAGES" };
    // D3 a second time, as PDF.js sees the file: document scripts and attachments.
    if ((await doc.getJSActions()) !== null || (await doc.getAttachments()) !== null) {
      return { ok: false, code: "PDF_ACTIVE_CONTENT" };
    }
    const paragraphs: string[] = [];
    let bytesSoFar = 0;
    for (let number = 1; number <= doc.numPages; number++) {
      const page = await doc.getPage(number);
      const text = await page.getTextContent();
      page.cleanup();
      for (const paragraph of joinLines(toLines(text.items))) {
        paragraphs.push(paragraph);
        bytesSoFar += Buffer.byteLength(paragraph, "utf8");
        // L2 early: reading on would only build what the bound refuses.
        if (bytesSoFar > MAX_EVIDENCE_SEGMENT_BYTES)
          return { ok: false, code: "CONTENT_TOO_LARGE" };
      }
    }
    return paragraphs;
  } finally {
    await task.destroy();
  }
}

/** Text items of one page as lines; an item with `hasEOL` ends its line. */
function toLines(items: readonly unknown[]): Line[] {
  const lines: Line[] = [];
  let text = "";
  let y = 0;
  let size = 0;
  const flush = () => {
    const clean = cleanText(text).replace(/\s+/gu, " ").trim();
    if (clean !== "") lines.push({ text: clean, y, size });
    text = "";
  };
  for (const item of items) {
    if (typeof item !== "object" || item === null || !("str" in item)) continue;
    const { str, hasEOL, transform } = item as {
      str: string;
      hasEOL: boolean;
      transform: number[];
    };
    if (str !== "") {
      if (text === "") {
        y = transform[5] ?? 0;
        size = Math.abs(transform[3] ?? 0);
      }
      text += str;
    }
    if (hasEOL) flush();
  }
  flush();
  return lines;
}

/**
 * Lines close together form a paragraph, joined with a space; a gap wider
 * than {@link PARAGRAPH_GAP} font sizes, or a new page, starts a new one.
 * A hyphen at a line end stays: undoing it would need a dictionary.
 */
function joinLines(lines: readonly Line[]): string[] {
  const paragraphs: string[] = [];
  let previous: Line | undefined;
  for (const line of lines) {
    const gap = previous === undefined ? Infinity : Math.abs(previous.y - line.y);
    const size = Math.max(previous?.size ?? 0, line.size, 1);
    if (gap > PARAGRAPH_GAP * size) paragraphs.push(line.text);
    else paragraphs[paragraphs.length - 1] = `${paragraphs.at(-1)} ${line.text}`.normalize("NFC");
    previous = line;
  }
  return paragraphs;
}

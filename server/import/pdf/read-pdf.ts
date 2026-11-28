import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFStream,
  type PDFObject,
} from "@cantoo/pdf-lib";
import { getResolvedPDFJS, type getDocumentProxy } from "unpdf";

import type {
  ImportReadLimitsV1,
  ImportReadRejectCode,
  ImportTraceV1,
} from "../../contracts/index.ts";
import {
  canonicalizeJcs,
  isForbiddenCodePoint,
  MAX_EVIDENCE_SEGMENT_BYTES,
  newNodeId,
  validateVersionedDocument,
  type CanonicalDocumentV2,
  type DocumentNodeV2,
} from "../../domain/index.ts";

import { hasPdfHeader } from "./signature.ts";

export type PdfRead =
  | {
      ok: true;
      content: CanonicalDocumentV2;
      contentCanonical: string;
      traces: ImportTraceV1[];
    }
  | { ok: false; code: ImportReadRejectCode | "pdf_no_text_layer" };

type PdfPage = Awaited<ReturnType<Awaited<ReturnType<typeof getDocumentProxy>>["getPage"]>>;

const ACTIVE_KEYS = ["JavaScript", "JS", "AA", "EmbeddedFiles", "EF", "XFA", "RichMediaContent"];
const ACTIVE_TYPES = ["JavaScript", "Launch", "EmbeddedFile", "FileAttachment", "RichMedia"];
const ACTIVE = { ok: false, code: "PDF_ACTIVE_CONTENT" } as const;

// Comment traces (ADR docs/adr/import-manifest-v2.md §2 and §4 t. 4).
const COMMENT_SUBTYPES = ["Text", "FreeText"];
const MAX_PAGE_TREE_DEPTH = 32;
const MAX_PAGE_ANNOTATIONS = 500;
const MAX_ANNOTATIONS = 5_000;

type CommentCount =
  | { ok: true; count: number }
  | { ok: false; code: "CONTENT_TOO_LARGE" | "PDF_INVALID" | "PDF_TOO_MANY_PAGES" };

/**
 * Count comment threads: page annotations of subtype Text or FreeText without
 * /IRT. A Popup belongs to its parent and a reply to its thread; markup
 * (Highlight, StrikeOut ...) is not a comment. Author, date, contents and
 * anything an annotation points to are never read (M1, M15, K8).
 */
function countComments(catalog: PDFDict, maxPages: number): CommentCount {
  const root = catalog.lookup(PDFName.of("Pages"));
  if (!(root instanceof PDFDict)) return { ok: false, code: "PDF_INVALID" };
  const pending: [PDFDict, number][] = [[root, 0]];
  const nodes = new Set<PDFDict>();
  const annotations = new Set<PDFDict>();
  let pages = 0;
  let count = 0;
  while (pending.length > 0) {
    const [node, depth] = pending.pop()!;
    if (nodes.has(node)) continue;
    nodes.add(node);
    const kids = node.lookup(PDFName.of("Kids"));
    const type = node.lookup(PDFName.of("Type"));
    if (kids instanceof PDFArray && !(type instanceof PDFName && type.decodeText() === "Page")) {
      if (depth >= MAX_PAGE_TREE_DEPTH) return { ok: false, code: "PDF_INVALID" };
      for (let index = 0; index < kids.size(); index += 1) {
        const kid = kids.lookup(index);
        if (kid instanceof PDFDict) pending.push([kid, depth + 1]);
      }
      continue;
    }
    pages += 1;
    if (pages > maxPages) return { ok: false, code: "PDF_TOO_MANY_PAGES" };
    const annots = node.lookup(PDFName.of("Annots"));
    if (!(annots instanceof PDFArray)) continue;
    if (annots.size() > MAX_PAGE_ANNOTATIONS) return { ok: false, code: "CONTENT_TOO_LARGE" };
    for (let index = 0; index < annots.size(); index += 1) {
      const annotation = annots.lookup(index);
      if (!(annotation instanceof PDFDict) || annotations.has(annotation)) continue;
      annotations.add(annotation);
      if (annotations.size > MAX_ANNOTATIONS) return { ok: false, code: "CONTENT_TOO_LARGE" };
      const subtype = annotation.lookup(PDFName.of("Subtype"));
      if (!(subtype instanceof PDFName) || !COMMENT_SUBTYPES.includes(subtype.decodeText())) {
        continue;
      }
      if (!annotation.has(PDFName.of("IRT"))) count += 1;
    }
  }
  return { ok: true, count };
}

/**
 * Inspect decoded PDF objects (also those in object streams), before reading
 * pages, and count the comment traces.
 */
async function inspectPdf(
  bytes: Uint8Array,
  maxPages: number,
): Promise<CommentCount | { ok: false; code: "PDF_ENCRYPTED" | "PDF_ACTIVE_CONTENT" }> {
  const { catalog, context, isEncrypted } = await PDFDocument.load(bytes, {
    ignoreEncryption: true,
    throwOnInvalidObject: true,
    updateMetadata: false,
  });
  if (isEncrypted) return { ok: false, code: "PDF_ENCRYPTED" };
  const pending = context.enumerateIndirectObjects().map(([, object]) => object);
  const seen = new Set<PDFObject>();
  while (pending.length > 0) {
    const object = pending.pop()!;
    if (seen.has(object)) continue;
    seen.add(object);
    if (object instanceof PDFStream) pending.push(object.dict);
    if (object instanceof PDFArray) {
      for (const item of object.asArray()) pending.push(item);
    }
    if (!(object instanceof PDFDict)) continue;
    if (ACTIVE_KEYS.some((key) => object.has(PDFName.of(key)))) return ACTIVE;
    if (object.has(PDFName.of("OpenAction"))) {
      // An explicit destination is allowed. An action dictionary is not.
      if (!(object.lookup(PDFName.of("OpenAction")) instanceof PDFArray)) return ACTIVE;
    }
    for (const key of ["S", "Type", "Subtype"]) {
      const name = object.lookup(PDFName.of(key));
      if (name instanceof PDFName && ACTIVE_TYPES.includes(name.decodeText())) return ACTIVE;
    }
    for (const [, value] of object.entries()) pending.push(value);
  }
  return countComments(catalog, maxPages);
}

function cleanLine(text: string): string {
  return Array.from(text.replace(/\p{Cc}/gu, " "))
    .filter((character) => !isForbiddenCodePoint(character.codePointAt(0)!))
    .join("")
    .normalize("NFC")
    .trim();
}

async function readPage(page: PdfPage, addLine: (line: string) => boolean): Promise<boolean> {
  const reader = page.streamTextContent().getReader();
  let line: string[] = [];
  let lineBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return addLine(line.join(""));
      for (const item of value.items) {
        if (!("str" in item)) continue;
        lineBytes += Buffer.byteLength(item.str, "utf8");
        if (lineBytes > MAX_EVIDENCE_SEGMENT_BYTES) return false;
        line.push(item.str);
        if (!item.hasEOL) continue;
        if (!addLine(line.join(""))) return false;
        line = [];
        lineBytes = 0;
      }
    }
  } finally {
    await reader.cancel();
  }
}

/** Run in the PDF import worker. Only the text layer is passed out. */
export async function readPdf(bytes: Uint8Array, limits: ImportReadLimitsV1): Promise<PdfRead> {
  if (bytes.length === 0) return { ok: false, code: "FILE_EMPTY" };
  if (bytes.length > limits.maxInputBytes) return { ok: false, code: "FILE_TOO_LARGE" };
  if (!hasPdfHeader(bytes)) return { ok: false, code: "FORMAT_NOT_ALLOWED" };
  try {
    const comments = await inspectPdf(bytes, limits.maxPdfPages);
    if (!comments.ok) return comments;
    const traces: ImportTraceV1[] =
      comments.count > 0 ? [{ traceKind: "comment", count: comments.count }] : [];
    const { getDocument, PasswordException } = await getResolvedPDFJS();
    const task = getDocument({
      data: Uint8Array.from(bytes),
      stopAtErrors: true,
      useSystemFonts: false,
      disableFontFace: true,
      useWasm: false,
      useWorkerFetch: false,
      maxImageSize: 1,
      verbosity: 0,
    });
    try {
      const document = await task.promise;
      if (document.numPages > limits.maxPdfPages) return { ok: false, code: "PDF_TOO_MANY_PAGES" };
      const nodes: DocumentNodeV2[] = [];
      const content: CanonicalDocumentV2 = { schemaVersion: 2, nodes, sources: [] };
      let contentBytes = Buffer.byteLength(canonicalizeJcs(content));
      const addLine = (line: string) => {
        const text = cleanLine(line);
        if (text === "") return true;
        const node: DocumentNodeV2 = {
          type: "paragraph",
          id: newNodeId(),
          children: [{ type: "text", text, marks: [] }],
        };
        contentBytes += Buffer.byteLength(canonicalizeJcs(node)) + (nodes.length > 0 ? 1 : 0);
        if (contentBytes > MAX_EVIDENCE_SEGMENT_BYTES) return false;
        nodes.push(node);
        return true;
      };
      for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
        const page = await document.getPage(pageNumber);
        if (!(await readPage(page, addLine))) return { ok: false, code: "CONTENT_TOO_LARGE" };
        page.cleanup();
      }
      if (nodes.length === 0) return { ok: false, code: "pdf_no_text_layer" };
      if (!validateVersionedDocument(content).ok) return { ok: false, code: "PDF_INVALID" };
      return { ok: true, content, contentCanonical: canonicalizeJcs(content), traces };
    } catch (error) {
      if (error instanceof PasswordException) return { ok: false, code: "PDF_ENCRYPTED" };
      return { ok: false, code: "PDF_INVALID" };
    } finally {
      await task.destroy();
    }
  } catch {
    return { ok: false, code: "PDF_INVALID" };
  }
}

// Reads a received PDF into a Ductura document v2 (SRV-1804, M8.3; ADR
// docs/adr/import-contract.md §4 and §8, class D). Only the text layer is
// read, with PDF.js, and nothing is run: no script (`isEvalSupported` off),
// no XFA, no font loading, no fetch of anything the file points to. The order
// is fixed: size, format, raw scan (encryption, active content), the document
// and its page count, active content PDF.js can see, then the text. The first
// failure is the answer, a code and nothing else; a PDF without any text
// (a scan) is PDF_NO_TEXT_LAYER, never an empty work. No author, date,
// producer or other metadata is read.
import type { ImportReadLimitsV1, ImportReadRejectCode } from "../../contracts/index.ts";
import {
  canonicalizeJcs,
  MAX_EVIDENCE_SEGMENT_BYTES,
  newNodeId,
  validateVersionedDocument,
  type CanonicalDocumentV2,
  type DocumentNodeV2,
} from "../../domain/index.ts";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { WorkerMessageHandler as workerMessageHandler } from "pdfjs-dist/legacy/build/pdf.worker.mjs";

import { cleanText } from "../docx/index.ts";

import { scanRawPdf } from "./active-content.ts";

// PDF.js in node runs its own worker code in this thread and finds it by an
// import() of ./pdf.worker.mjs next to pdf.mjs, which a bundle does not have
// (dist/pdf-import-worker.js). Handing it the handler it would load makes the
// bundle work like the sources, with no file read at run time.
declare global {
  var pdfjsWorker: unknown;
}
globalThis.pdfjsWorker = Object.fromEntries([["WorkerMessageHandler", workerMessageHandler]]);

export type PdfRead =
  | {
      readonly ok: true;
      readonly content: CanonicalDocumentV2;
      /** JCS of the content: the text whose SHA-256 is `contentSha256`. */
      readonly contentCanonical: string;
    }
  | { readonly ok: false; readonly code: ImportReadRejectCode };

/** The time PDF.js may take for a whole file (D4). */
export const PDF_READ_TIMEOUT_MS = 20_000;

type Loaded = {
  readonly numPages: number;
  getPage(n: number): Promise<{
    getTextContent(): Promise<{ items: unknown[] }>;
    getAnnotations(): Promise<unknown[]>;
    cleanup(): void;
  }>;
  hasJSActions(): Promise<boolean>;
  getJSActions(): Promise<Record<string, unknown> | null>;
  getOpenAction(): Promise<{ action?: unknown } | null>;
  getAttachments(): Promise<unknown>;
  destroy(): Promise<void>;
};

type TextItem = { str: string; hasEOL: boolean; transform: number[]; height: number };
const isTextItem = (item: unknown): item is TextItem =>
  typeof item === "object" &&
  item !== null &&
  typeof (item as TextItem).str === "string" &&
  Array.isArray((item as TextItem).transform);

class Refused extends Error {
  readonly code: ImportReadRejectCode;
  constructor(code: ImportReadRejectCode) {
    super(code);
    this.code = code;
  }
}

const PDF_MAGIC = "%PDF-";

function hasPdfHeader(bytes: Uint8Array): boolean {
  const head = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.length, 1024)).toString(
    "latin1",
  );
  return head.includes(PDF_MAGIC);
}

/** Lines of one page into paragraphs: a gap above 1.6 line heights starts a new one. */
function paragraphsOf(items: unknown[]): string[] {
  const paragraphs: string[] = [];
  let current = "";
  let lastY: number | null = null;
  let lastHeight = 0;
  const flush = () => {
    const text = cleanText(current).replace(/ {2,}/g, " ").trim();
    if (text !== "") paragraphs.push(text);
    current = "";
  };
  for (const item of items) {
    if (!isTextItem(item)) continue;
    const y = item.transform[5] ?? 0;
    const height = item.height > 0 ? item.height : Math.abs(item.transform[3] ?? 0);
    if (lastY !== null && lastHeight > 0 && Math.abs(lastY - y) > lastHeight * 1.6) flush();
    else if (lastY !== null && Math.abs(lastY - y) > 0.5 && current !== "" && !/\s$/.test(current))
      current += " ";
    current += item.str;
    if (item.hasEOL && !/\s$/.test(current)) current += " ";
    if (item.str.trim() !== "") {
      lastY = y;
      lastHeight = height;
    }
  }
  flush();
  return paragraphs;
}

async function extract(bytes: Uint8Array, limits: ImportReadLimitsV1): Promise<string[]> {
  const task = pdfjs.getDocument({
    // A copy: PDF.js takes ownership of the buffer it is given.
    data: new Uint8Array(bytes),
    isEvalSupported: false,
    enableXfa: false,
    disableFontFace: true,
    useSystemFonts: false,
    useWorkerFetch: false,
    isOffscreenCanvasSupported: false,
    stopAtErrors: true,
    verbosity: 0,
  });
  let doc: Loaded;
  try {
    doc = (await task.promise) as unknown as Loaded;
  } catch (error) {
    const name = (error as { name?: string } | null)?.name;
    if (name === "PasswordException") throw new Refused("PDF_ENCRYPTED");
    throw new Refused("PDF_INVALID");
  }
  try {
    if (doc.numPages > limits.maxPdfPages) throw new Refused("PDF_TOO_MANY_PAGES");
    const scripts = await doc.getJSActions();
    if ((await doc.hasJSActions()) || (scripts !== null && Object.keys(scripts).length > 0)) {
      throw new Refused("PDF_ACTIVE_CONTENT");
    }
    const open = await doc.getOpenAction();
    if (open !== null && open !== undefined && open.action !== undefined) {
      throw new Refused("PDF_ACTIVE_CONTENT");
    }
    const attachments = await doc.getAttachments();
    if (attachments !== null && attachments !== undefined && Object.keys(attachments).length > 0) {
      throw new Refused("PDF_ACTIVE_CONTENT");
    }
    const paragraphs: string[] = [];
    for (let n = 1; n <= doc.numPages; n += 1) {
      const page = await doc.getPage(n);
      for (const annotation of await page.getAnnotations()) {
        const a = annotation as { actions?: unknown; action?: unknown; subtype?: string };
        if (
          a.subtype === "FileAttachment" ||
          a.action === "Launch" ||
          (typeof a.actions === "object" && a.actions !== null && Object.keys(a.actions).length > 0)
        ) {
          throw new Refused("PDF_ACTIVE_CONTENT");
        }
      }
      const content = await page.getTextContent();
      paragraphs.push(...paragraphsOf(content.items));
      page.cleanup();
    }
    return paragraphs;
  } catch (error) {
    if (error instanceof Refused) throw error;
    throw new Refused("PDF_INVALID");
  } finally {
    await doc.destroy().catch(() => undefined);
  }
}

export async function readPdf(
  bytes: Uint8Array,
  limits: ImportReadLimitsV1,
  uuid?: () => string,
): Promise<PdfRead> {
  if (bytes.length === 0) return { ok: false, code: "FILE_EMPTY" };
  if (bytes.length > limits.maxInputBytes) return { ok: false, code: "FILE_TOO_LARGE" };
  if (!hasPdfHeader(bytes)) return { ok: false, code: "FORMAT_NOT_ALLOWED" };
  const raw = scanRawPdf(bytes);
  if (raw !== null) return { ok: false, code: raw };
  let paragraphs: string[];
  let timer: NodeJS.Timeout | undefined;
  try {
    paragraphs = await Promise.race([
      extract(bytes, limits),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Refused("PDF_INVALID")), PDF_READ_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    return { ok: false, code: error instanceof Refused ? error.code : "PDF_INVALID" };
  } finally {
    clearTimeout(timer);
  }
  if (paragraphs.length === 0) return { ok: false, code: "PDF_NO_TEXT_LAYER" };
  const nodes: DocumentNodeV2[] = paragraphs.map((text) => ({
    type: "paragraph",
    id: newNodeId(uuid),
    children: [{ type: "text", text, marks: [] }],
  }));
  const content: CanonicalDocumentV2 = { schemaVersion: 2, nodes, sources: [] };
  // The converter only builds what document v2 takes; a refusal here is a bug, read as a broken file.
  if (!validateVersionedDocument(content).ok) return { ok: false, code: "PDF_INVALID" };
  const contentCanonical = canonicalizeJcs(content);
  // L2: too much text for one segment is refused, never cut.
  if (Buffer.byteLength(contentCanonical, "utf8") > MAX_EVIDENCE_SEGMENT_BYTES) {
    return { ok: false, code: "CONTENT_TOO_LARGE" };
  }
  return { ok: true, content, contentCanonical };
}

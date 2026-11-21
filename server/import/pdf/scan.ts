// The structural scan of a received PDF (SRV-1804, M8.3; ADR
// docs/adr/import-contract.md §4 and attack rows D2, D3). pdf-lib parses the
// file, object streams included, and every indirect object is visited once in
// a flat loop, so a cycle of references cannot recurse. Names are compared
// after pdf-lib has decoded their #xx escapes. Nothing found is ever run.
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRawStream,
  PDFStream,
  type PDFContext,
  type PDFObject,
} from "pdf-lib";

import type { ImportReadRejectCode } from "../../contracts/index.ts";

export type PdfScan =
  { readonly ok: true } | { readonly ok: false; readonly code: ImportReadRejectCode };

/** A key whose mere presence is active content: script, launch, attachment, form, media. */
const ACTIVE_KEYS: ReadonlySet<string> = new Set([
  "JavaScript",
  "JS",
  "Launch",
  "EmbeddedFile",
  "EmbeddedFiles",
  "EF",
  "XFA",
  "RichMedia",
  "RichMediaContent",
]);

/**
 * The only actions a PDF may carry: a jump inside the file, a link (its target
 * is text, never fetched, like the DOCX hyperlink) and a named viewer command.
 * Most thesis exports open with a GoTo, so an OpenAction is judged by its kind.
 */
const ALLOWED_ACTIONS: ReadonlySet<string> = new Set(["GoTo", "URI", "Named"]);

/** A type that is active content wherever it stands. */
const ACTIVE_TYPES: ReadonlySet<string> = new Set(["EmbeddedFile", "RichMediaContent"]);

const nameOf = (value: PDFObject | undefined) =>
  value instanceof PDFName ? value.decodeText() : undefined;

const MEDIA_SUBTYPES: ReadonlySet<string> = new Set([
  "FileAttachment",
  "RichMedia",
  "Movie",
  "Sound",
  "Screen",
]);
/** Keys whose value is an action; /S means an action kind only there (StructElem and SMask reuse /S). */
const ACTION_KEYS = ["A", "OpenAction", "Next"] as const;

function dictOf(object: PDFObject | undefined): PDFDict | undefined {
  if (object instanceof PDFDict) return object;
  if (object instanceof PDFStream || object instanceof PDFRawStream) return object.dict;
  return undefined;
}

/**
 * An action whose kind is not allowed. Under /OpenAction an array is a
 * destination (a page and a view), never an action; only /Next holds a list
 * of actions.
 */
function isForbiddenAction(
  context: PDFContext,
  value: PDFObject | undefined,
  listAllowed = false,
): boolean {
  const resolved = context.lookup(value);
  if (resolved instanceof PDFArray && !listAllowed) return false;
  const items = resolved instanceof PDFArray ? resolved.asArray() : [resolved];
  for (const item of items) {
    const action = dictOf(context.lookup(item));
    if (action === undefined) continue;
    const kind = nameOf(action.get(PDFName.of("S")));
    if (kind === undefined || !ALLOWED_ACTIONS.has(kind)) return true;
  }
  return false;
}

function isActive(context: PDFContext, dict: PDFDict): boolean {
  for (const [key, value] of dict.entries()) {
    const name = key.decodeText();
    if (ACTIVE_KEYS.has(name)) return true;
    if (name === "Type" && nameOf(value) === "Action" && isForbiddenAction(context, dict))
      return true;
    if (name === "Type" && ACTIVE_TYPES.has(nameOf(value) ?? "")) return true;
    if (name === "Subtype" && MEDIA_SUBTYPES.has(nameOf(value) ?? "")) return true;
    if (
      (ACTION_KEYS as readonly string[]).includes(name) &&
      isForbiddenAction(context, value, name === "Next")
    )
      return true;
    // Additional actions (page open, field change ...) are triggers that run without a click.
    if (name === "AA" && dictOf(context.lookup(value)) !== undefined) return true;
  }
  return false;
}

/** A direct dictionary nested in another (an inline action) is visited too, without recursion. */
function directChildren(dict: PDFDict): PDFDict[] {
  const out: PDFDict[] = [];
  for (const [, value] of dict.entries()) {
    if (value instanceof PDFDict) out.push(value);
    else if (value instanceof PDFArray) {
      for (const item of value.asArray()) if (item instanceof PDFDict) out.push(item);
    }
  }
  return out;
}

export async function scanPdf(bytes: Uint8Array): Promise<PdfScan> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, {
      ignoreEncryption: true,
      updateMetadata: false,
      throwOnInvalidObject: true,
    });
  } catch {
    return { ok: false, code: "PDF_INVALID" };
  }
  // D2: an /Encrypt in the trailer is an encrypted file, even one that opens without a password.
  if (doc.isEncrypted || doc.context.trailerInfo.Encrypt !== undefined) {
    return { ok: false, code: "PDF_ENCRYPTED" };
  }
  // D3: every object once; nested direct dictionaries go on a work list, not the stack.
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    const root = dictOf(object);
    if (root === undefined) continue;
    const work = [root];
    let visited = 0;
    while (work.length > 0) {
      const dict = work.pop()!;
      if (isActive(doc.context, dict)) return { ok: false, code: "PDF_ACTIVE_CONTENT" };
      // A direct object cannot refer to itself, but a bound keeps a hostile nesting cheap.
      if (++visited > 10_000) return { ok: false, code: "PDF_INVALID" };
      work.push(...directChildren(dict));
    }
  }
  return { ok: true };
}

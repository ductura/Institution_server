// Refuses a PDF that is encrypted or can act (SRV-1804, M8.3; ADR
// docs/adr/import-contract.md §4 and §8, class D). Only the text of a PDF is
// read; JavaScript, Launch, embedded files, XFA and RichMedia reject the whole
// import. This first pass reads the raw bytes as Latin-1 names, with `#xx`
// escapes in names decoded (`/J#61vaScript` is `/JavaScript`); the reader then
// asks PDF.js for what the raw pass cannot see inside compressed object
// streams (read-pdf.ts). Nothing is run, opened or fetched.
import type { ImportReadRejectCode } from "../../contracts/index.ts";

const ACTIVE_NAMES: ReadonlySet<string> = new Set([
  "JavaScript",
  "JS",
  "Launch",
  "EmbeddedFile",
  "EmbeddedFiles",
  "XFA",
  "RichMedia",
  "FileAttachment",
]);

const NAME = /\/([^\s/<>[\](){}%]+)/g;
const HEX_ESCAPE = /#([0-9A-Fa-f]{2})/g;
const OPEN_ACTION_WITH_ACTION = /\/OpenAction\s*<<[^>]*\/S\s*\/(?:JavaScript|Launch)/;

/** The refusal the raw bytes already give, or null when they show none. */
export function scanRawPdf(bytes: Uint8Array): ImportReadRejectCode | null {
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");
  let encrypted = false;
  let active = false;
  for (const match of text.matchAll(NAME)) {
    const name = match[1]!.replace(HEX_ESCAPE, (_, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    );
    if (name === "Encrypt") encrypted = true;
    else if (ACTIVE_NAMES.has(name)) active = true;
  }
  if (OPEN_ACTION_WITH_ACTION.test(text)) active = true;
  // Encryption first: an encrypted file cannot be read for anything else.
  if (encrypted) return "PDF_ENCRYPTED";
  return active ? "PDF_ACTIVE_CONTENT" : null;
}

// Which reader a received file goes to, by its content and never by its name
// (ADR docs/adr/import-manifest-v2.md §4 t. 3). A PDF starts with "%PDF-", an
// ODT with its stored mimetype entry; everything else goes to the DOCX
// reader, which refuses what is not a DOCX with a code of the contract.
import { hasOdtSignature } from "./odt/index.ts";
import { hasPdfHeader } from "./pdf/index.ts";

export type ImportReaderFormat = "docx" | "pdf" | "odt";

export function importFormatOf(bytes: Uint8Array): ImportReaderFormat {
  if (hasPdfHeader(bytes)) return "pdf";
  if (hasOdtSignature(bytes)) return "odt";
  return "docx";
}

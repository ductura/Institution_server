// Import of files into a work (SRV-1803, M8.2; ADR docs/adr/import-contract.md).
// Readers for DOCX, PDF and ODT (ADR docs/adr/import-manifest-v2.md) and the
// previews they build. Who may import and the record of the import are the
// database's (server/database/import).
export {
  prepareDocxImport,
  readDocx,
  type DocxImportPrepared,
  type DocxImportPreview,
  type DocxRead,
} from "./docx/index.ts";
export { importFormatOf, type ImportReaderFormat } from "./format.ts";
export { hasOdtSignature, readOdt, type OdtRead } from "./odt/index.ts";
export { hasPdfHeader, preparePdfImport } from "./pdf/index.ts";

// Import of files into a work (SRV-1803, M8.2; ADR docs/adr/import-contract.md).
// Today only DOCX; the reader and the preview it builds. Who may import and
// the record of the import are the database's (server/database/import).
export {
  prepareDocxImport,
  readDocx,
  type DocxImportPrepared,
  type DocxImportPreview,
  type DocxRead,
} from "./docx/index.ts";

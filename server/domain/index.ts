export type { AppError, Result } from "./result.ts";
export * from "./json/index.ts";
export * from "./document/index.ts";
export * from "./collaboration/index.ts";
export * from "./forensics/index.ts";
export * from "./evidence/index.ts";
export * from "./settings/index.ts";
export * from "./jobs/index.ts";
export * from "./assignment/index.ts";
export * from "./profile/index.ts";
export * from "./sync/index.ts";
export * from "./support/index.ts";
export * from "./text/index.ts";
export * from "./assistant/index.ts";
export * from "./declaration/index.ts";
export * from "./export-snapshot/index.ts";
export * from "./provenance-share/index.ts";
// SRV-V19-DNEVNIK-RUTE: the digest and the input checks of the practice journal.
export * from "./practice-journal/index.ts";
// SRV-V19-GRUPA-RUTE: order of team members and assembly of the contribution.
export * from "./work-team/index.ts";
// SRV-V19-RECENZIJA-RUTE: the anonymous answers of the peer review.
export * from "./peer-review/index.ts";
// SRV-1230: the deterministic match with an answer of the assistant.
export * from "./assistant-match/index.ts";
export * from "./retention/index.ts";
export { zagrebWall, type ZagrebWall } from "./time/index.ts";
// SRV-V18-UPITNIK-BAZA: the definition, the answers and the export of a questionnaire.
export * from "./questionnaire/index.ts";
// SRV-V18-KODIRANJE-BAZA: the material, the anchors, the codebook and the export of qualitative coding.
export * from "./qualitative-coding/index.ts";
// SRV-V13-UGOVOR-SLAJD: the canonical document of a slides work (docs/contracts/slides-v1.md).
export * from "./slides/index.ts";
// SRV-V15-IZVRSITELJ: the statistical analysis of val 15 (stateless, deterministic).
export * from "./analysis/index.ts";
// SRV-1308: the student data export lists the access log by day, as the student reads it.
export { accessLogDaysOf, type AccessLogDay } from "./privacy/index.ts";
// Both document and evidence name a `SourceId` (Ductus keeps them in separate
// folders): the document's is the source of a citation, the evidence one the
// source of an evidence basis. The explicit exports settle which is which.
export type { SourceId } from "./document/index.ts";
export type { SourceId as EvidenceSourceId } from "./evidence/index.ts";
// SRV-V14-SHEET-XLSX: the sheet document and its formula computer, read by the .xlsx export.
export {
  columnLabel,
  parseCellRef,
  sheetDigest,
  validateSheetDocument,
  type Sheet,
  type SheetDocument,
} from "./sheet/index.ts";
export {
  computeSheet,
  parseFormula,
  type ComputedCell,
  type FormulaNode,
} from "./sheet/formula/index.ts";

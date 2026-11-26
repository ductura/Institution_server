// Public interface of server/downloads; other areas import only this file.
export { DOWNLOADS_ROUTES } from "./routes.ts";
export { DOWNLOADS_SCHEMAS } from "./schemas.ts";
export { renderReceiptPdf } from "./receipt-pdf/index.ts";
// SRV-1531: the PDF of the interview preparation of a work (N-14).
export {
  renderInterviewPdf,
  type InterviewPdfInput,
  type InterviewPdfLabels,
} from "./interview-pdf/index.ts";
// SRV-1512: the display-equality test (server/tests) renders a DOCX from an export snapshot.
export {
  A4_PAGE,
  buildExportModel,
  renderDocx,
  renderSheetCsv,
  renderSheetCsvOfText,
  renderSheetXlsx,
  XLSX_TYPE,
  renderWorkDocx,
  type ExportLabels,
  type SheetCsv,
} from "./export/index.ts";
// SRV-1902: the ZIP of all submissions of an assignment uses the same deterministic writer.
export { writeZip, type ZipEntry } from "./export/index.ts";
export {
  createSnapshotPdf,
  freezePdfSource,
  localPdfConverter,
  localSlidesPdfConverter,
  PPTX_TYPE,
  renderSlidesExport,
  slidesBodyKind,
  type ConvertDocx,
  type ConvertPptx,
  type SlidesBodyKind,
  type SlidesExport,
  type SlidesExportFormat,
  type SlidesExportInput,
} from "./export/pdf/index.ts";
export {
  createMerlinRosterReader,
  merlinRosterCsv,
  type MerlinLabels,
  type MerlinRosterDeps,
  type MerlinRosterRead,
  type MerlinRosterReader,
  type MerlinRosterRow,
} from "./merlin/roster/index.ts";
export {
  buildMerlinPackageZip,
  createMerlinPackageService,
  MERLIN_PACKAGE_CSV,
  MERLIN_PACKAGE_FINGERPRINTS,
  type MerlinPackageAsk,
  type MerlinPackageService,
  type MerlinPackageServiceDeps,
} from "./merlin/packages/index.ts";
export {
  createDownloadsService,
  DOWNLOADS_ERRORS,
  DOWNLOADS_RELEASES_INVALID,
  DOWNLOADS_RELEASES_ORDER,
  DOWNLOADS_RELEASES_UNREADABLE,
  type DownloadsManifest,
  type DownloadsPackage,
  type DownloadsService,
} from "./service.ts";
// SRV-1312: the portable record of a submission and its offline check (scripts/evidence-verify).
export {
  buildPortableRecord,
  PENDING_DAILY_ROOT,
  PORTABLE_RECORD_FILENAME,
  PORTABLE_RECORD_FILES,
  verifyPortableRecord,
  type DailyRootCheck,
  type PortableDailyRootSource,
  type PortableRecordBuild,
  type PortableRecordProblem,
  type PortableRecordSource,
  type PortableRecordVerification,
} from "./portable-record/index.ts";
// SRV-1807: the 24 hour link to the export package and to the confirmation for the registrar.
export {
  buildSubmissionPackage,
  checkPackageLink,
  issuePackageLink,
  PACKAGE_KINDS,
  PACKAGE_LINK_TTL_MS,
  REFERADA_CONFIRMATION_FILENAME,
  type PackageKind,
  type PackageLink,
  type PackageLinkCheck,
  type SubmissionPackageBuild,
} from "./submission-package/index.ts";

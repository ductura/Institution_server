// The DOCX of a work on the dev fake server (work.export.get, SRV-1310): the
// same reader as the versions list (readerOf). The fake keeps only the
// document of the current revision, so that is the one version it can export
// (the submitted one once the work is submitted); another versionId is the
// same 404. The bytes come from the real export snapshot and renderer, so the
// same version gives the same bytes and the same X-Export-Snapshot-Sha256. The
// real source, its access log row and the submission cut are app.read_work_export.
// The CSV of one sheet of a spreadsheet work (SRV-V14-SHEET-CSV) is served here too.
import { merlinHr } from "../../../locales/index.ts";
import {
  freezeExportSnapshot,
  validateSheetDocument,
  validateVersionedDocument,
  type CanonicalDocumentV4,
} from "../../../server/domain/index.ts";
import {
  A4_PAGE,
  buildExportModel,
  renderDocx,
  renderSheetCsv,
  renderSheetXlsx,
  XLSX_TYPE,
} from "../../../server/downloads/index.ts";
import type { Handlers } from "./server.ts";
import { readerOf } from "./state.ts";

const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const DAY_MS = 24 * 60 * 60 * 1000;

export const WORK_EXPORT_HANDLERS: Handlers = {
  "work.export.get": ({ state, account, params, query }) => {
    if (account === null) return { error: "unauthorized" };
    const work = state.works.find((w) => w.documentId === params.documentId);
    if (work === undefined || readerOf(state, work, account) === null)
      return { error: "not_found" };
    if (query.format !== "docx") return { error: "invalid_input" };
    const asked = query.versionId === undefined ? work.revision : Number(query.versionId);
    if (work.revision < 1 || asked !== work.revision || work.lastChangeAt === null)
      return { error: "not_found" };
    const checked = validateVersionedDocument(
      JSON.parse(Buffer.from(work.document, "base64").toString("utf8")),
    );
    if (!checked.ok) return { error: "not_found" };
    const snapshot = freezeExportSnapshot({
      document: checked.doc as CanonicalDocumentV4,
      versionId: String(work.revision),
      kind: work.submittedAt === null ? "saved" : "submitted",
      pageSetup: A4_PAGE,
      cover: { institution: "", unit: "", workType: "", student: "", mentor: "" },
      expiresAt: new Date(Date.parse(work.lastChangeAt) + DAY_MS).toISOString(),
    });
    const model = buildExportModel(snapshot.document as CanonicalDocumentV4, merlinHr.exportLabels);
    return {
      status: 200,
      headers: {
        "cache-control": "private, no-store",
        "x-export-snapshot-sha256": snapshot.sha256,
      },
      body: new Blob([renderDocx(model, snapshot.cover, snapshot.pageSetup)], { type: DOCX_TYPE }),
    };
  },
  // SRV-V14-SHEET-CSV: the CSV of one sheet of a spreadsheet work, for the readers of the DOCX.
  // A work whose document is not a valid spreadsheet (a text work) and an unknown
  // sheet are the same 404. The real source is app.read_work_export.
  "work.export-sheet-csv.get": ({ state, account, params, query }) => {
    if (account === null) return { error: "unauthorized" };
    const work = state.works.find((w) => w.documentId === params.documentId);
    if (work === undefined || readerOf(state, work, account) === null)
      return { error: "not_found" };
    if (
      Object.keys(query).some((key) => key !== "sheet") ||
      (query.sheet !== undefined &&
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
          query.sheet,
        ))
    )
      return { error: "invalid_input" };
    let raw: unknown;
    try {
      raw = JSON.parse(Buffer.from(work.document, "base64").toString("utf8"));
    } catch {
      return { error: "not_found" };
    }
    const checked = validateSheetDocument(raw);
    if (!checked.ok) return { error: "not_found" };
    const csv = renderSheetCsv(checked.doc, query.sheet ?? null);
    if (csv.status !== "ok") return { error: "not_found" };
    return {
      status: 200,
      headers: {
        "cache-control": "private, no-store",
        "content-disposition": 'attachment; filename="rad.csv"',
      },
      body: new Blob([csv.bytes], { type: "text/csv" }),
    };
  },
  // SRV-V14-SHEET-XLSX: the .xlsx of a spreadsheet work; a text work is the same 404 as another's.
  "work.export-sheet-xlsx.get": ({ state, account, params, query }) => {
    if (account === null) return { error: "unauthorized" };
    const work = state.works.find((w) => w.documentId === params.documentId);
    if (work === undefined || readerOf(state, work, account) === null)
      return { error: "not_found" };
    const asked = query.versionId === undefined ? work.revision : Number(query.versionId);
    if (work.revision < 1 || asked !== work.revision) return { error: "not_found" };
    const xlsx = renderSheetXlsx({ body: Buffer.from(work.document, "base64").toString("utf8") });
    if (xlsx.status !== "rendered") return { error: "not_found" };
    return {
      status: 200,
      headers: {
        "cache-control": "private, no-store",
        "x-export-sheet-sha256": xlsx.sheetSha256,
      },
      body: new Blob([xlsx.bytes], { type: XLSX_TYPE }),
    };
  },
};

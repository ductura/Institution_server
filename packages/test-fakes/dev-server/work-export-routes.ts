// The DOCX of a work on the dev fake server (work.export.get, SRV-1310): the
// same reader as the versions list (readerOf). The fake keeps only the
// document of the current revision, so that is the one version it can export
// (the submitted one once the work is submitted); another versionId is the
// same 404. The bytes come from the real export snapshot and renderer, so the
// same version gives the same bytes and the same X-Export-Snapshot-Sha256. The
// real source, its access log row and the submission cut are app.read_work_export.
import { merlinHr } from "../../../locales/index.ts";
import {
  freezeExportSnapshot,
  validateVersionedDocument,
  type CanonicalDocumentV4,
} from "../../../server/domain/index.ts";
import { A4_PAGE, buildExportModel, renderDocx } from "../../../server/downloads/index.ts";
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
};

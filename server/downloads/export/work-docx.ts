// The DOCX of one stored version of a work (SRV-1310, plan M8.4): the stored
// text is read as a versioned document, frozen as an export snapshot
// (SRV-1309) and rendered from that snapshot only, so the same version gives
// the same bytes and the same fingerprint. The caller (server/http/work-export)
// has already checked access and read the text.
import {
  freezeExportSnapshot,
  validateVersionedDocument,
  type CanonicalDocumentV4,
} from "../../domain/index.ts";
import { A4_PAGE, renderDocx } from "./docx.ts";
import { buildExportModel, type ExportLabels } from "./model.ts";

/** The snapshot of a version stays valid for a day after the version was stored (as the Merlin link, C-16). */
const SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000;

export type WorkDocxInput = {
  /** The exact stored bytes of the text of the revision. */
  readonly body: string;
  readonly revision: number;
  /** When the version was stored, an ISO instant. */
  readonly savedAt: string;
  readonly labels: ExportLabels;
};

export type WorkDocx =
  | { readonly status: "rendered"; readonly bytes: Uint8Array; readonly snapshotSha256: string }
  /** The stored text is not a document the export reads; the reason is a closed code. */
  | { readonly status: "unreadable"; readonly reason: "body_not_json" | "body_invalid" };

export function renderWorkDocx(input: WorkDocxInput): WorkDocx {
  let stored: unknown;
  try {
    stored = JSON.parse(input.body);
  } catch {
    return { status: "unreadable", reason: "body_not_json" };
  }
  const checked = validateVersionedDocument(stored);
  if (!checked.ok) return { status: "unreadable", reason: "body_invalid" };
  const snapshot = freezeExportSnapshot({
    // A v1 to v3 document has only the blocks of v4 that the export reads (as the Merlin files).
    document: checked.doc as CanonicalDocumentV4,
    versionId: String(input.revision),
    // Always "saved": the kind of a revision changes when it is submitted, and the
    // fingerprint of the same document and versionId must not change with it.
    kind: "saved",
    pageSetup: A4_PAGE,
    // No name, institution or mentor is read for the cover yet (open item in the PR).
    cover: { institution: "", unit: "", workType: "", student: "", mentor: "" },
    expiresAt: new Date(Date.parse(input.savedAt) + SNAPSHOT_TTL_MS).toISOString(),
  });
  const model = buildExportModel(snapshot.document as CanonicalDocumentV4, input.labels);
  return {
    status: "rendered",
    bytes: renderDocx(model, snapshot.cover, snapshot.pageSetup),
    snapshotSha256: snapshot.sha256,
  };
}

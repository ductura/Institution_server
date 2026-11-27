// The confirmed document version of a work (SRV-7F, Ductus#2028;
// docs/contracts/document-schema-v3.md §6 and §7). A work has one version
// from revision 0 to submission, and the version is the schemaVersion in the
// hashed bytes of its revision 0 (Ductus document-schema-v2.md §7 t. 3).
// Revision 0 is only ever written by the database from a fixed function
// (evidence.revision_zero_document, _v2, and the v3 one of contract v3 §7),
// so its hash names the version exactly: the server's own record of revision
// 0, never the client's snapshot, decides it. A hash that is none of the
// three is no revision 0 this server writes, and the caller treats it as a
// malformed row, never as a version it guesses.
import {
  isSha256Hex,
  REVISION_ZERO_SHA256,
  REVISION_ZERO_V2_SHA256,
  REVISION_ZERO_V3_SHA256,
} from "../domain/index.ts";

import type { ActorTransaction } from "./with-actor.ts";

export type DocumentSchemaVersion = 1 | 2 | 3;

/**
 * The kinds of work whose revision 0 this file knows: text; spreadsheet
 * (SRV-V14-SHEET-COMMIT), whose one revision 0 is `sheetRevisionZeroDocument`
 * of the sheet domain; and slides (F4-V13-R01), whose one revision 0 is
 * `slidesRevisionZeroDocument` of the slides domain.
 */
export type RevisionZeroKind = "text" | "spreadsheet" | "slides";

/**
 * SHA-256 of the JCS bytes of the slides revision 0, lowercase hex (the
 * slides domain's `SLIDES_REVISION_ZERO_SHA256`, written out here for the same
 * reason as the others; a test checks it against the domain).
 */
export const SLIDES_REVISION_ZERO_HASH =
  "f593200307d93c988cc050521ab02853510a424d59763d575de83fda1cf8a0d8";

/** The version of the slides model of that revision 0 (`slidesSchemaVersion` of evidence.open.post). */
const SLIDES_REVISION_ZERO_VERSION = 1;

/**
 * SHA-256 of the JCS bytes of the spreadsheet revision 0, lowercase hex
 * (computed with `sha256sum`; a test checks it against the sheet domain).
 * Written out, like the text hashes, so the hash that names a work is never
 * recomputed from code that could change.
 */
export const SHEET_REVISION_ZERO_SHA256 =
  "70f7ffa27faf9f771316120c2b2f94e351aed32af3b94177d4c85ff56b0066e4";

/**
 * The version of the spreadsheet model of that revision 0 (the sheet
 * domain's `SHEET_SCHEMA_VERSION`, `sheetSchemaVersion` of evidence.open.post).
 */
const SHEET_REVISION_ZERO_VERSION = 1;

export type WorkVersion = {
  /** The schemaVersion of the work's revision 0, and so of every revision. */
  schemaVersion: DocumentSchemaVersion;
  /** SHA-256 of revision 0 as the database recorded it. */
  revisionZeroHash: string;
};

// A Map, not an object: a hash such as `__proto__` is no version.
const VERSION_BY_REVISION_ZERO = new Map<string, DocumentSchemaVersion>([
  [REVISION_ZERO_SHA256, 1],
  [REVISION_ZERO_V2_SHA256, 2],
  [REVISION_ZERO_V3_SHA256, 3],
]);

/** The version a revision-0 hash names, or null for any other value. */
export function schemaVersionOfRevisionZero(hash: unknown): DocumentSchemaVersion | null {
  return typeof hash === "string" ? (VERSION_BY_REVISION_ZERO.get(hash) ?? null) : null;
}

/**
 * The version a revision-0 hash names for a work of this kind, or null. The
 * kind and the hash must agree: a text hash on a spreadsheet work, or the
 * spreadsheet hash on a text work, names no version.
 */
function versionOfKind(kind: RevisionZeroKind, hash: string): DocumentSchemaVersion | null {
  if (kind === "slides") {
    return hash === SLIDES_REVISION_ZERO_HASH ? SLIDES_REVISION_ZERO_VERSION : null;
  }
  if (kind === "spreadsheet") {
    return hash === SHEET_REVISION_ZERO_SHA256 ? SHEET_REVISION_ZERO_VERSION : null;
  }
  return kind === "text" ? schemaVersionOfRevisionZero(hash) : null;
}

// Under RLS the session sees only its own institution's revisions of its own
// documents (evidence_revision_read); revision 0 is never updated or deleted.
const REVISION_ZERO_SQL = `SELECT content_hash FROM evidence.document_revision
 WHERE document_id = $1 AND revision = 0`;

/**
 * The version of the caller's own document, read in the caller's transaction,
 * or null when there is not exactly one revision 0 or its hash is no known
 * revision 0 of a work of `kind` (text unless named; SRV-V14-SHEET-COMMIT).
 */
export async function readWorkVersion(
  tx: ActorTransaction,
  documentId: string,
  kind: RevisionZeroKind = "text",
): Promise<WorkVersion | null> {
  const { rows } = await tx.query<Record<string, unknown>>(REVISION_ZERO_SQL, [documentId]);
  const hash = rows.length === 1 ? rows[0]?.content_hash : undefined;
  if (!isSha256Hex(hash)) return null;
  const schemaVersion = versionOfKind(kind, hash);
  return schemaVersion === null ? null : { schemaVersion, revisionZeroHash: hash };
}

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

// Under RLS the session sees only its own institution's revisions of its own
// documents (evidence_revision_read); revision 0 is never updated or deleted.
const REVISION_ZERO_SQL = `SELECT content_hash FROM evidence.document_revision
 WHERE document_id = $1 AND revision = 0`;

/**
 * The version of the caller's own document, read in the caller's transaction,
 * or null when there is not exactly one revision 0 or its hash is no known
 * revision 0.
 */
export async function readWorkVersion(
  tx: ActorTransaction,
  documentId: string,
): Promise<WorkVersion | null> {
  const { rows } = await tx.query<Record<string, unknown>>(REVISION_ZERO_SQL, [documentId]);
  const hash = rows.length === 1 ? rows[0]?.content_hash : undefined;
  if (!isSha256Hex(hash)) return null;
  const schemaVersion = schemaVersionOfRevisionZero(hash);
  return schemaVersion === null ? null : { schemaVersion, revisionZeroHash: hash };
}

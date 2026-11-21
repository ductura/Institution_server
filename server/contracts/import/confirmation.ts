/**
 * Idempotent review confirmation of an import (SRV-1801, D-290; ADR
 * docs/adr/import-contract.md §5, attack classes P1 to P9).
 *
 * A pure decision over the stored import and the request. It writes nothing:
 * the SRV-1803 (M8.2) RPC takes the row lock, calls this and then either
 * appends the one `import` segment event or returns the stored event id. A
 * repeated confirmation of the same manifest never makes a second event.
 */
import { Type, type Static } from "@sinclair/typebox";

import { IMPORT_PENDING_LIFETIME_MS } from "./limits.ts";
import { SHA256_HEX_PATTERN, UUID_V4_PATTERN } from "./manifest.ts";

/**
 * The request body: the import and the manifest hash the student reviewed.
 * The document comes from the path and the actor from the session, never
 * from the body.
 */
export const ImportConfirmBodyV1 = Type.Object(
  {
    importId: Type.String({ pattern: UUID_V4_PATTERN }),
    manifestSha256: Type.String({ pattern: SHA256_HEX_PATTERN }),
  },
  { additionalProperties: false },
);
export type ImportConfirmBodyV1 = Static<typeof ImportConfirmBodyV1>;

/** The same answer for the first confirmation and every retry of it (P1, P8). */
export const ImportConfirmResponseV1 = Type.Object(
  {
    importId: Type.String({ pattern: UUID_V4_PATTERN }),
    eventId: Type.String({ minLength: 1, maxLength: 256 }),
  },
  { additionalProperties: false },
);
export type ImportConfirmResponseV1 = Static<typeof ImportConfirmResponseV1>;

export type ImportRecordStateV1 = "pending" | "confirmed" | "cancelled";

/** What the decision reads of the stored `import_event` row. */
export type ImportRecordV1 = Readonly<{
  importId: string;
  ownerId: string;
  documentId: string;
  manifestSha256: string;
  /** Document revision the import was prepared against. */
  baseRevision: number;
  preparedAtMs: number;
  state: ImportRecordStateV1;
  /** Event id of the confirmation, present only in state `confirmed`. */
  confirmedEventId?: string;
}>;

export type ImportConfirmRequestV1 = Readonly<{
  importId: string;
  actorId: string;
  documentId: string;
  /** The manifest hash the student reviewed. */
  manifestSha256: string;
}>;

export type ImportConfirmContextV1 = Readonly<{
  nowMs: number;
  currentRevision: number;
  /** False when the work no longer takes imports (assignment switch D-282, submitted, locked, archived). */
  importAllowed: boolean;
}>;

/** Codes only: a rejection never carries input content (D-198 t. 5). */
export const IMPORT_CONFIRM_REJECT_CODES = Object.freeze([
  "NOT_FOUND",
  "MANIFEST_MISMATCH",
  "CANCELLED",
  "EXPIRED",
  "IMPORT_NOT_ALLOWED",
  "REVISION_CHANGED",
] as const);
export type ImportConfirmRejectCode = (typeof IMPORT_CONFIRM_REJECT_CODES)[number];

/**
 * PRIJEDLOG for the route of SRV-1803: HTTP status and problem code of each
 * rejection, in the order of {@link IMPORT_CONFIRM_REJECT_CODES}. A stranger's
 * import is 404 like a missing one (P4).
 */
export const IMPORT_CONFIRM_ERRORS: readonly Readonly<{
  reason: ImportConfirmRejectCode;
  status: number;
  code: string;
}>[] = Object.freeze([
  { reason: "NOT_FOUND", status: 404, code: "import_not_found" },
  { reason: "MANIFEST_MISMATCH", status: 409, code: "import_manifest_mismatch" },
  { reason: "CANCELLED", status: 409, code: "import_cancelled" },
  { reason: "EXPIRED", status: 410, code: "import_expired" },
  { reason: "IMPORT_NOT_ALLOWED", status: 403, code: "import_not_allowed" },
  { reason: "REVISION_CHANGED", status: 409, code: "import_revision_changed" },
]);

export type ImportConfirmDecisionV1 =
  | { kind: "confirm" }
  | { kind: "already-confirmed"; eventId: string }
  | { kind: "reject"; code: ImportConfirmRejectCode };

const reject = (code: ImportConfirmRejectCode): ImportConfirmDecisionV1 => ({
  kind: "reject",
  code,
});
const SHA256_HEX = new RegExp(SHA256_HEX_PATTERN, "u");
const isId = (value: unknown): value is string => typeof value === "string" && value !== "";

/**
 * Decides one confirmation. The order is fixed: a stranger learns nothing
 * beyond `NOT_FOUND` (another owner and another document look like a missing
 * import), and a finished import answers before any time or revision check,
 * so a retry after success is always `already-confirmed`.
 */
export function decideImportConfirmation(
  record: ImportRecordV1 | null,
  request: ImportConfirmRequestV1,
  context: ImportConfirmContextV1,
): ImportConfirmDecisionV1 {
  if (
    record === null ||
    !isId(record.importId) ||
    !isId(record.ownerId) ||
    !isId(record.documentId) ||
    record.importId !== request.importId ||
    record.ownerId !== request.actorId ||
    record.documentId !== request.documentId
  )
    return reject("NOT_FOUND");
  // A record without a valid stored hash is inconsistent and is never confirmed.
  if (!SHA256_HEX.test(record.manifestSha256)) return reject("NOT_FOUND");

  // A malformed reviewed hash can never equal the valid stored one.
  const sameManifest = record.manifestSha256 === request.manifestSha256;
  if (record.state === "confirmed") {
    if (!sameManifest) return reject("MANIFEST_MISMATCH");
    if (typeof record.confirmedEventId !== "string" || record.confirmedEventId === "")
      return reject("NOT_FOUND");
    return { kind: "already-confirmed", eventId: record.confirmedEventId };
  }
  if (record.state === "cancelled") return reject("CANCELLED");
  // A pending record that already names an event is inconsistent (E2): confirming it would make a second event.
  if (record.state !== "pending" || record.confirmedEventId !== undefined)
    return reject("NOT_FOUND");

  if (!sameManifest) return reject("MANIFEST_MISMATCH");
  // The window is [preparedAtMs, preparedAtMs + lifetime); a prepare time in the future does not extend it.
  if (!Number.isFinite(context.nowMs) || !Number.isFinite(record.preparedAtMs))
    return reject("EXPIRED");
  if (
    context.nowMs < record.preparedAtMs ||
    context.nowMs >= record.preparedAtMs + IMPORT_PENDING_LIFETIME_MS
  )
    return reject("EXPIRED");
  if (context.importAllowed !== true) return reject("IMPORT_NOT_ALLOWED");
  // Revisions are integers; anything else on either side is treated as a changed revision.
  if (!Number.isSafeInteger(record.baseRevision) || context.currentRevision !== record.baseRevision)
    return reject("REVISION_CHANGED");
  return { kind: "confirm" };
}

// SRV-1803 (M8.2 and M8.2b, DAN-396; contract docs/adr/import-contract.md):
// the database port of an import (20261202100000). Each call is one withActor
// transaction over one RPC of schema collaboration; the RPCs decide who may:
// only the student owner of the work, only while its assignment allows import
// (D-282) and the work is not submitted. The base revision and every time come
// from the database. The answer is a closed status, never a database message
// or SQLSTATE: ZD401 is unauthenticated, ZD403 not_found (one answer for "not
// yours", "not there" and "no relation", C-23), ZD422 invalid, anything else
// unavailable, as is a row of an unexpected shape. The rejections of a
// confirmation are the codes of the contract (IMPORT_CONFIRM_REJECT_CODES).
import type { ActorTransaction, WithActor } from "../index.ts";

export type ImportRefusal = {
  readonly status: "unauthenticated" | "not_found" | "invalid" | "unavailable";
};
export type ImportGate = { readonly status: "allowed" | "not_allowed" };
export type ImportPrepared =
  | { readonly status: "prepared"; readonly baseRevision: number; readonly preparedAt: string }
  | { readonly status: "not_allowed" };
export type ImportConfirmRejection =
  | "NOT_FOUND"
  | "MANIFEST_MISMATCH"
  | "CANCELLED"
  | "EXPIRED"
  | "IMPORT_NOT_ALLOWED"
  | "REVISION_CHANGED";
export type ImportConfirmed =
  | { readonly status: "confirmed" | "already-confirmed"; readonly eventId: string }
  | { readonly status: "rejected"; readonly code: ImportConfirmRejection };

/** The state of an import as the database derives it (confirmed, expired or pending). */
export type ImportState = "pending" | "confirmed" | "expired";
/** The metadata of one import of a work; never its manifest, a hash or any content. */
export type ImportListed = {
  readonly importId: string;
  readonly importKind: "file-upload" | "cloud-version";
  readonly fileFormat: "docx" | "pdf";
  readonly rawByteLength: number;
  /** Normalised (D-292), or null. */
  readonly fileName: string | null;
  readonly baseRevision: number;
  readonly preparedAt: string;
  readonly state: ImportState;
  readonly confirmedAt: string | null;
  readonly eventId: string | null;
};
export type ImportList = { readonly status: "listed"; readonly imports: readonly ImportListed[] };

export type PrepareImportInput = {
  readonly documentId: string;
  readonly importId: string;
  /** The canonical JCS text of the manifest the server built. */
  readonly manifest: string;
  readonly manifestSha256: string;
  /** Normalised (D-292), or null. */
  readonly fileName: string | null;
};

export type Imports = {
  gate(token: string, documentId: string): Promise<ImportGate | ImportRefusal>;
  prepare(token: string, input: PrepareImportInput): Promise<ImportPrepared | ImportRefusal>;
  confirm(
    token: string,
    documentId: string,
    importId: string,
    manifestSha256: string,
  ): Promise<ImportConfirmed | ImportRefusal>;
  /** The imports of a work, newest first, for its student owner and a teacher of its assignment. */
  list(token: string, documentId: string): Promise<ImportList | ImportRefusal>;
};

const SQL = {
  gate: "SELECT outcome FROM collaboration.import_gate($1)",
  prepare:
    'SELECT outcome, base_revision AS "baseRevision", prepared_at AS "preparedAt" FROM collaboration.prepare_import($1, $2, $3, $4, $5)',
  confirm: 'SELECT outcome, event_id AS "eventId" FROM collaboration.confirm_import($1, $2, $3)',
  list: `SELECT import_id AS "importId", import_kind AS "importKind", file_format AS "fileFormat",
       raw_byte_length AS "rawByteLength", file_name AS "fileName", base_revision AS "baseRevision",
       prepared_at AS "preparedAt", state, confirmed_at AS "confirmedAt", event_id AS "eventId"
  FROM collaboration.list_imports($1)`,
} as const;
/** The database returns at most this many imports of one work. */
const MAX_LISTED = 200;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REJECTIONS: readonly string[] = [
  "NOT_FOUND",
  "MANIFEST_MISMATCH",
  "CANCELLED",
  "EXPIRED",
  "IMPORT_NOT_ALLOWED",
  "REVISION_CHANGED",
];

/** Thrown inside the transaction for a row of an unexpected shape. */
class Malformed extends Error {}

/** The code of a database error; a getter or Proxy that throws has none. */
function codeOf(thrown: unknown): unknown {
  try {
    return thrown && typeof thrown === "object" && "code" in thrown ? thrown.code : undefined;
  } catch {
    return undefined;
  }
}

function refusal(thrown: unknown): ImportRefusal {
  if (thrown instanceof Malformed) return { status: "unavailable" };
  const code = codeOf(thrown);
  if (code === "ZD401") return { status: "unauthenticated" };
  if (code === "ZD403") return { status: "not_found" };
  if (code === "ZD422") return { status: "invalid" };
  return { status: "unavailable" };
}

/** A bigint column arrives as text from pg; it is a safe integer here. */
function revisionOf(value: unknown): number {
  const number = typeof value === "string" && /^[0-9]{1,16}$/.test(value) ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 0)
    throw new Malformed();
  return number;
}

function instantOf(value: unknown): string {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new Malformed();
  return value.toISOString();
}

function listedOf(row: Record<string, unknown>): ImportListed {
  const { importId, importKind, fileFormat, rawByteLength, fileName, state, eventId } = row;
  if (typeof importId !== "string" || !UUID.test(importId)) throw new Malformed();
  if (importKind !== "file-upload" && importKind !== "cloud-version") throw new Malformed();
  if (fileFormat !== "docx" && fileFormat !== "pdf") throw new Malformed();
  if (typeof rawByteLength !== "number" || !Number.isSafeInteger(rawByteLength))
    throw new Malformed();
  if (fileName !== null && typeof fileName !== "string") throw new Malformed();
  if (state !== "pending" && state !== "confirmed" && state !== "expired") throw new Malformed();
  // A confirmation has a time and one event id; nothing else has either.
  const confirmed = state === "confirmed";
  if (confirmed !== (row.confirmedAt !== null) || confirmed !== (eventId !== null))
    throw new Malformed();
  if (confirmed && (typeof eventId !== "string" || !UUID.test(eventId))) throw new Malformed();
  return {
    importId,
    importKind,
    fileFormat,
    rawByteLength,
    fileName,
    baseRevision: revisionOf(row.baseRevision),
    preparedAt: instantOf(row.preparedAt),
    state,
    confirmedAt: confirmed ? instantOf(row.confirmedAt) : null,
    eventId: confirmed ? (eventId as string) : null,
  };
}

export function createImports(withActor: WithActor): Imports {
  async function one(
    token: string,
    sql: string,
    params: unknown[],
  ): Promise<Record<string, unknown> | ImportRefusal> {
    try {
      return await withActor(token, async (tx: ActorTransaction) => {
        const rows = (await tx.query<Record<string, unknown>>(sql, params)).rows;
        if (rows.length !== 1) throw new Malformed();
        return rows[0]!;
      });
    } catch (thrown) {
      return refusal(thrown);
    }
  }
  const isRefusal = (value: Record<string, unknown> | ImportRefusal): value is ImportRefusal =>
    "status" in value;

  return {
    async list(token, documentId) {
      try {
        return await withActor(token, async (tx: ActorTransaction) => {
          const rows = (await tx.query<Record<string, unknown>>(SQL.list, [documentId])).rows;
          if (rows.length > MAX_LISTED) throw new Malformed();
          return { status: "listed" as const, imports: rows.map(listedOf) };
        });
      } catch (thrown) {
        return refusal(thrown);
      }
    },

    async gate(token, documentId) {
      const row = await one(token, SQL.gate, [documentId]);
      if (isRefusal(row)) return row;
      if (row.outcome === "allowed" || row.outcome === "not_allowed")
        return { status: row.outcome };
      return { status: "unavailable" };
    },

    async prepare(token, input) {
      const row = await one(token, SQL.prepare, [
        input.documentId,
        input.importId,
        input.manifest,
        input.manifestSha256,
        input.fileName,
      ]);
      if (isRefusal(row)) return row;
      if (row.outcome === "not_allowed") return { status: "not_allowed" };
      try {
        if (row.outcome !== "prepared") throw new Malformed();
        const at = row.preparedAt;
        if (!(at instanceof Date) || Number.isNaN(at.getTime())) throw new Malformed();
        return {
          status: "prepared",
          baseRevision: revisionOf(row.baseRevision),
          preparedAt: at.toISOString(),
        };
      } catch (thrown) {
        return refusal(thrown);
      }
    },

    async confirm(token, documentId, importId, manifestSha256) {
      const row = await one(token, SQL.confirm, [documentId, importId, manifestSha256]);
      if (isRefusal(row)) return row;
      if (
        (row.outcome === "confirmed" || row.outcome === "already-confirmed") &&
        typeof row.eventId === "string" &&
        UUID.test(row.eventId)
      ) {
        return { status: row.outcome, eventId: row.eventId };
      }
      if (
        typeof row.outcome === "string" &&
        REJECTIONS.includes(row.outcome) &&
        row.eventId === null
      ) {
        return { status: "rejected", code: row.outcome as ImportConfirmRejection };
      }
      return { status: "unavailable" };
    },
  };
}

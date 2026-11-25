// SRV-1308 (M10.5; D-271 MQ02): the adapter over the student data export of
// SRV-1307 and the worker reads of its package. The web side runs the RPCs
// with the caller's session (the database decides who may: a clerk of the
// registry office requests, a confirmed administrator approves); the link is
// used without a session, since it alone carries the right. The worker side
// runs over the worker's own login. Every row is checked before it leaves
// this folder; an answer is the port's shape or a closed status, never the
// driver's text.
import type { Pool } from "pg";

import type { WithActor } from "../index.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STATES = ["requested", "approved", "ready", "downloaded", "expired"] as const;

export type StudentDataExportState = (typeof STATES)[number];

export type StudentDataExportRow = {
  exportId: string;
  /** Who the export is for (SRV-NF7-IZVOZ-STUDENT); only the students route sends it. */
  studentId: string;
  state: StudentDataExportState;
  requestedAt: string;
  /** Null until the package is ready. */
  expiresAt: string | null;
};

type Refusal = {
  status:
    "unauthenticated" | "forbidden" | "not_found" | "conflict" | "invalid" | "gone" | "unavailable";
};

export type StudentDataExports = {
  request(
    token: string,
    input: { studentId: string; identityCheckRef: string },
  ): Promise<{ status: "ok"; exportId: string } | Refusal>;
  approve(
    token: string,
    exportId: string,
    jobRef: string,
  ): Promise<{ status: "ok"; exportId: string; state: "approved" } | Refusal>;
  list(token: string): Promise<{ status: "ok"; exports: StudentDataExportRow[] } | Refusal>;
  /**
   * Lets a ready link through once and hands `load` the export id inside the
   * same transaction: if `load` throws, the link stays unused.
   */
  consume<T>(
    tokenHash: Uint8Array,
    load: (exportId: string) => Promise<T>,
  ): Promise<{ status: "ok"; exportId: string; value: T } | Refusal>;
};

const REFUSALS = new Map<unknown, Refusal["status"]>([
  ["ZD401", "unauthenticated"],
  ["ZD403", "forbidden"],
  ["ZD404", "not_found"],
  ["ZD409", "conflict"],
  ["ZD410", "gone"],
  ["ZD422", "invalid"],
]);

/** A refusal of the database by its code; anything else, a throw of `load` too, is unavailable. */
function refusal(error: unknown): Refusal {
  const code = error instanceof Error && "code" in error ? error.code : undefined;
  return { status: REFUSALS.get(code) ?? "unavailable" };
}

function instant(value: unknown): string | undefined {
  return value instanceof Date && !Number.isNaN(value.getTime()) ? value.toISOString() : undefined;
}

function rowOf(row: Record<string, unknown>): StudentDataExportRow | undefined {
  const requestedAt = instant(row.requestedAt);
  const expiresAt = row.expiresAt === null ? null : instant(row.expiresAt);
  if (
    typeof row.exportId !== "string" ||
    !UUID.test(row.exportId) ||
    typeof row.studentId !== "string" ||
    !UUID.test(row.studentId) ||
    !STATES.includes(row.state as StudentDataExportState) ||
    requestedAt === undefined ||
    expiresAt === undefined
  ) {
    return undefined;
  }
  return {
    exportId: row.exportId,
    studentId: row.studentId,
    state: row.state as StudentDataExportState,
    requestedAt,
    expiresAt,
  };
}

class LoadFailed extends Error {}

export function createStudentDataExports(withActor: WithActor): StudentDataExports {
  async function ask(token: string | null, sql: string, params: unknown[]) {
    return (await withActor(token, (tx) => tx.query<Record<string, unknown>>(sql, params))).rows;
  }

  return {
    async request(token, { studentId, identityCheckRef }) {
      if (!UUID.test(studentId)) return { status: "not_found" };
      let rows: Record<string, unknown>[];
      try {
        rows = await ask(
          token,
          'SELECT app.request_student_data_export($1::uuid, true, $2)::text AS "exportId"',
          [studentId, identityCheckRef],
        );
      } catch (error) {
        return refusal(error);
      }
      const exportId = rows.length === 1 ? rows[0]!.exportId : undefined;
      if (typeof exportId !== "string" || !UUID.test(exportId)) return { status: "unavailable" };
      return { status: "ok", exportId };
    },

    async approve(token, exportId, jobRef) {
      exportId = exportId.toLowerCase();
      if (!UUID.test(exportId)) return { status: "not_found" };
      let rows: Record<string, unknown>[];
      try {
        rows = await ask(
          token,
          'SELECT app.approve_student_data_export($1::uuid, $2) AS "approvedAt"',
          [exportId, jobRef],
        );
      } catch (error) {
        return refusal(error);
      }
      if (rows.length !== 1 || instant(rows[0]!.approvedAt) === undefined)
        return { status: "unavailable" };
      return { status: "ok", exportId, state: "approved" };
    },

    async list(token) {
      let rows: Record<string, unknown>[];
      try {
        rows = await ask(
          token,
          `SELECT export_id::text AS "exportId", student_id::text AS "studentId", status AS "state",
                  requested_at AS "requestedAt", expires_at AS "expiresAt"
             FROM app.student_data_exports()`,
          [],
        );
      } catch (error) {
        return refusal(error);
      }
      const exports: StudentDataExportRow[] = [];
      for (const row of rows) {
        const one = rowOf(row);
        if (!one) return { status: "unavailable" };
        exports.push(one);
      }
      return { status: "ok", exports };
    },

    async consume(tokenHash, load) {
      if (tokenHash.byteLength !== 32) return { status: "gone" };
      try {
        return await withActor(null, async (tx) => {
          const { rows } = await tx.query<Record<string, unknown>>(
            'SELECT export_id::text AS "exportId" FROM app.consume_student_data_export($1::bytea)',
            [Buffer.from(tokenHash)],
          );
          const exportId = rows.length === 1 ? rows[0]!.exportId : undefined;
          if (typeof exportId !== "string" || !UUID.test(exportId)) throw new LoadFailed("row");
          let value: Awaited<ReturnType<typeof load>>;
          try {
            value = await load(exportId);
          } catch {
            throw new LoadFailed("load");
          }
          return { status: "ok" as const, exportId, value };
        });
      } catch (error) {
        return refusal(error);
      }
    },
  };
}

/** One submission that stands, its exact text and its stored receipt (null while unsigned). */
export type StudentDataExportSubmission = {
  submissionId: string;
  assignmentId: string;
  revision: number;
  requestedAt: string;
  body: string;
  receipt: { payload: string; payloadDigestSha256: string; signature: unknown } | null;
};

export type StudentDataExportNote = {
  noteId: string;
  assignmentId: string;
  createdAt: string;
  text: string;
};

/** The person's package as the worker reads it; the access log rows as app.read_my_access_log gives them. */
export type StudentDataExportContents = {
  submissions: StudentDataExportSubmission[];
  notes: StudentDataExportNote[];
  accessLog: Record<string, unknown>[];
};

export type StudentDataExportJobRow = { exportId: string; jobRef: string };

type WorkerFail = { status: "unavailable" };

export type StudentDataExportWorkerPort = {
  toPrepare(): Promise<{ status: "ok"; jobs: StudentDataExportJobRow[] } | WorkerFail>;
  contents(
    exportId: string,
  ): Promise<{ status: "ok"; contents: StudentDataExportContents } | WorkerFail>;
  /** approved -> ready with the SHA-256 of the link's token; returns when the link expires. */
  markReady(
    exportId: string,
    tokenHash: Uint8Array,
  ): Promise<{ status: "ok"; expiresAt: string } | { status: "conflict" | "unavailable" }>;
  expire(): Promise<{ status: "ok"; expired: number } | WorkerFail>;
};

const FAIL: WorkerFail = { status: "unavailable" };

async function rowsOf(db: Pick<Pool, "query">, sql: string, values: unknown[]) {
  try {
    return (await db.query<Record<string, unknown>>(sql, values)).rows;
  } catch {
    // The driver's message can carry the connection string; nothing of it leaves.
    return undefined;
  }
}

function submissionOf(row: Record<string, unknown>): StudentDataExportSubmission | undefined {
  const requestedAt = instant(row.requestedAt);
  const revision = Number(row.revision);
  if (
    typeof row.submissionId !== "string" ||
    !UUID.test(row.submissionId) ||
    typeof row.assignmentId !== "string" ||
    !UUID.test(row.assignmentId) ||
    !Number.isSafeInteger(revision) ||
    revision < 1 ||
    requestedAt === undefined ||
    typeof row.body !== "string"
  ) {
    return undefined;
  }
  let receipt: StudentDataExportSubmission["receipt"];
  if (row.payload === null && row.digest === null && row.signature === null) {
    receipt = null;
  } else if (
    typeof row.payload === "string" &&
    typeof row.digest === "string" &&
    row.signature !== null
  ) {
    receipt = { payload: row.payload, payloadDigestSha256: row.digest, signature: row.signature };
  } else {
    return undefined;
  }
  return {
    submissionId: row.submissionId,
    assignmentId: row.assignmentId,
    revision,
    requestedAt,
    body: row.body,
    receipt,
  };
}

function noteOf(row: Record<string, unknown>): StudentDataExportNote | undefined {
  const createdAt = instant(row.createdAt);
  if (
    typeof row.noteId !== "string" ||
    !UUID.test(row.noteId) ||
    typeof row.assignmentId !== "string" ||
    !UUID.test(row.assignmentId) ||
    createdAt === undefined ||
    typeof row.text !== "string"
  ) {
    return undefined;
  }
  return { noteId: row.noteId, assignmentId: row.assignmentId, createdAt, text: row.text };
}

function all<T>(
  rows: Record<string, unknown>[],
  of: (row: Record<string, unknown>) => T | undefined,
) {
  const out: T[] = [];
  for (const row of rows) {
    const one = of(row);
    if (one === undefined) return undefined;
    out.push(one);
  }
  return out;
}

/** The worker's port over its own login (only the worker process builds it, D-71). */
export function createStudentDataExportWorker(
  db: Pick<Pool, "query">,
): StudentDataExportWorkerPort {
  return {
    async toPrepare() {
      const rows = await rowsOf(
        db,
        'SELECT export_id::text AS "exportId", job_ref AS "jobRef" FROM app.worker_student_data_exports_to_prepare()',
        [],
      );
      if (rows === undefined) return FAIL;
      const jobs = all(rows, (row) =>
        typeof row.exportId === "string" &&
        UUID.test(row.exportId) &&
        typeof row.jobRef === "string"
          ? { exportId: row.exportId, jobRef: row.jobRef }
          : undefined,
      );
      return jobs === undefined ? FAIL : { status: "ok", jobs };
    },

    async contents(exportId) {
      if (!UUID.test(exportId)) return FAIL;
      const [submissionRows, noteRows, accessRows] = await Promise.all([
        rowsOf(
          db,
          `SELECT submission_id::text AS "submissionId", assignment_id::text AS "assignmentId",
                  revision::text AS revision, requested_at AS "requestedAt", body,
                  receipt_payload AS payload, payload_digest_sha256 AS digest, signature
             FROM app.worker_student_data_export_submissions($1::uuid)`,
          [exportId],
        ),
        rowsOf(
          db,
          `SELECT note_id::text AS "noteId", assignment_id::text AS "assignmentId",
                  created_at AS "createdAt", text
             FROM app.worker_student_data_export_notes($1::uuid)`,
          [exportId],
        ),
        rowsOf(
          db,
          `SELECT entry_id::text AS entry_id, opened_at, surface, reader_role, reader_given_name,
                  reader_family_name
             FROM app.worker_student_data_export_access_log($1::uuid)`,
          [exportId],
        ),
      ]);
      if (submissionRows === undefined || noteRows === undefined || accessRows === undefined)
        return FAIL;
      const submissions = all(submissionRows, submissionOf);
      const notes = all(noteRows, noteOf);
      if (submissions === undefined || notes === undefined) return FAIL;
      return { status: "ok", contents: { submissions, notes, accessLog: accessRows } };
    },

    async markReady(exportId, tokenHash) {
      if (!UUID.test(exportId) || tokenHash.byteLength !== 32) return FAIL;
      let rows: Record<string, unknown>[];
      try {
        rows = (
          await db.query<Record<string, unknown>>(
            'SELECT app.worker_mark_student_data_export_ready($1::uuid, $2::bytea) AS "expiresAt"',
            [exportId, Buffer.from(tokenHash)],
          )
        ).rows;
      } catch (error) {
        return refusal(error).status === "conflict" ? { status: "conflict" } : FAIL;
      }
      const expiresAt = rows.length === 1 ? instant(rows[0]!.expiresAt) : undefined;
      return expiresAt === undefined ? FAIL : { status: "ok", expiresAt };
    },

    async expire() {
      const rows = await rowsOf(
        db,
        'SELECT app.worker_expire_student_data_exports() AS "expired"',
        [],
      );
      const expired = rows?.length === 1 ? rows[0]!.expired : undefined;
      return typeof expired === "number" && Number.isSafeInteger(expired) && expired >= 0
        ? { status: "ok", expired }
        : FAIL;
    },
  };
}

// The port of a work's source list (SRV-7B; migrations 20261120180000 and
// 20261120190000). The student of the work saves and removes the own sources;
// a teacher of the work saves and removes recommended and required ones; both
// read the list. Every write goes through an RPC, never the table, and the
// student and institution come only from the session.
//
// The record is checked here in full (validateSources, document-schema-v2
// §2, the one source model of D-226) before the database checks its closed
// shape again; the DOI and the ISBN must already be in their one spelling
// (DOI in lowercase, ISBN as digits with a valid check digit). Refusals are
// outcomes, never thrown: ZD401 unauthorized, ZD403 not_found (one answer for
// every refusal, C-23), ZD422 invalid_input. Anything else is thrown.
import {
  isPlainObject,
  validateSources,
  type DocumentSource,
  type ValidationError,
} from "../../domain/index.ts";

import type { WithActor } from "../index.ts";

export type WorkSourceRequirement = "recommended" | "required";

export type WorkSource = {
  readonly id: string;
  readonly record: DocumentSource;
  readonly doi: string | null;
  readonly isbn: string | null;
  readonly undated: boolean;
  readonly requirement: WorkSourceRequirement | null;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type WorkSourceInput = {
  readonly assignmentId: string;
  readonly record: unknown;
  readonly doi?: string | null;
  readonly isbn?: string | null;
  readonly undated?: boolean;
};

type Refusal = { readonly status: "unauthorized" | "not_found" };
export type WorkSourceList = { readonly status: "read"; readonly sources: WorkSource[] } | Refusal;
export type WorkSourceSave =
  | { readonly status: "saved"; readonly source: WorkSource }
  | Refusal
  | { readonly status: "invalid_input" };
export type WorkSourceRemove = { readonly status: "removed" | "absent" } | Refusal;

const FIELDS =
  'id, record, doi, isbn, undated, requirement, created_at AS "createdAt", updated_at AS "updatedAt"';
const LIST_SQL = `SELECT ${FIELDS} FROM institution.work_sources($1::uuid, $2::uuid)`;
const SAVE_SQL = `SELECT ${FIELDS} FROM institution.save_work_source($1::uuid, $2::jsonb, $3::text, $4::text, $5::boolean)`;
const TEACHER_SAVE_SQL = `SELECT ${FIELDS}
  FROM institution.save_teacher_work_source($1::uuid, $2::uuid, $3::jsonb, $4::text, $5::text, $6::text, $7::boolean)`;
const REMOVE_SQL = "SELECT institution.delete_work_source($1::uuid, $2::uuid) AS removed";
const TEACHER_REMOVE_SQL =
  "SELECT institution.delete_teacher_work_source($1::uuid, $2::uuid, $3::uuid) AS removed";

const LOWER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const DOI = /^10\.[0-9]{4,9}\/[!-~]+$/u;
const ISBN = /^(?:[0-9]{9}[0-9X]|97[89][0-9]{10})$/u;

type WorkSourceRow = {
  id: unknown;
  record: unknown;
  doi: unknown;
  isbn: unknown;
  undated: unknown;
  requirement: unknown;
  createdAt: unknown;
  updatedAt: unknown;
};

const isId = (value: unknown): value is string =>
  typeof value === "string" && LOWER_UUID.test(value);

/** A DOI in its one spelling: lowercase, printable ASCII, at most 300. */
export function isWorkSourceDoi(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 300 &&
    DOI.test(value) &&
    value === value.toLowerCase()
  );
}

/** An ISBN-10 or ISBN-13 as its digits, with a valid check digit. */
export function isWorkSourceIsbn(value: unknown): value is string {
  if (typeof value !== "string" || !ISBN.test(value)) return false;
  const digits = [...value].map((c) => (c === "X" ? 10 : Number(c)));
  if (digits.length === 10) return digits.reduce((sum, d, i) => sum + d * (10 - i), 0) % 11 === 0;
  return digits.reduce((sum, d, i) => sum + d * (i % 2 === 0 ? 1 : 3), 0) % 10 === 0;
}

/** The record checked as one entry of `sources`, or undefined. */
function recordOf(value: unknown): DocumentSource | undefined {
  if (!isPlainObject(value)) return undefined;
  const errors: ValidationError[] = [];
  const [source] = validateSources([value], errors);
  return errors.length === 0 ? source : undefined;
}

type Checked = {
  record: DocumentSource;
  doi: string | null;
  isbn: string | null;
  undated: boolean;
};

function checkedOf(input: WorkSourceInput): Checked | undefined {
  const record = recordOf(input.record);
  const doi = input.doi ?? null;
  const isbn = input.isbn ?? null;
  const undated = input.undated ?? false;
  if (record === undefined || !isId(input.assignmentId) || typeof undated !== "boolean")
    return undefined;
  if ((doi !== null && !isWorkSourceDoi(doi)) || (isbn !== null && !isWorkSourceIsbn(isbn)))
    return undefined;
  return { record, doi, isbn, undated };
}

function instantOf(value: unknown): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("invalid work source timestamp");
  }
  return value.toISOString();
}

function sourceOf(row: WorkSourceRow): WorkSource {
  const record = recordOf(row.record);
  const { requirement } = row;
  if (
    !isId(row.id) ||
    record === undefined ||
    record.id !== row.id ||
    (row.doi !== null && !isWorkSourceDoi(row.doi)) ||
    (row.isbn !== null && typeof row.isbn !== "string") ||
    typeof row.undated !== "boolean" ||
    (requirement !== null && requirement !== "recommended" && requirement !== "required")
  ) {
    throw new Error("invalid work source row");
  }
  return {
    id: row.id,
    record,
    doi: row.doi,
    isbn: row.isbn,
    undated: row.undated,
    requirement,
    createdAt: instantOf(row.createdAt),
    updatedAt: instantOf(row.updatedAt),
  };
}

function codeOf(error: unknown): unknown {
  try {
    return error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
  } catch {
    return undefined;
  }
}

function refusalOf(code: unknown): Refusal | undefined {
  if (code === "ZD401") return { status: "unauthorized" };
  if (code === "ZD403") return { status: "not_found" };
  return undefined;
}

export function createWorkSources(withActor: WithActor) {
  async function save(
    token: string,
    sql: string,
    params: unknown[],
    id: string,
  ): Promise<WorkSourceSave> {
    try {
      return await withActor(token, async (tx) => {
        const { rows } = await tx.query<WorkSourceRow>(sql, params);
        const row = rows[0];
        // Confirmed inside the transaction, so a result that is not the
        // saved source rolls the write back.
        if (rows.length !== 1 || row === undefined || row.id !== id)
          throw new Error("unconfirmed work source");
        return { status: "saved", source: sourceOf(row) };
      });
    } catch (error) {
      const code = codeOf(error);
      if (code === "ZD422") return { status: "invalid_input" };
      const refusal = refusalOf(code);
      if (refusal !== undefined) return refusal;
      throw error;
    }
  }

  async function remove(token: string, sql: string, params: unknown[]): Promise<WorkSourceRemove> {
    try {
      return await withActor(token, async (tx) => {
        const { rows } = await tx.query<{ removed: unknown }>(sql, params);
        const removed = rows[0]?.removed;
        if (rows.length !== 1 || typeof removed !== "boolean")
          throw new Error("unconfirmed work source removal");
        return { status: removed ? "removed" : "absent" };
      });
    } catch (error) {
      const refusal = refusalOf(codeOf(error));
      if (refusal !== undefined) return refusal;
      throw error;
    }
  }

  return {
    /** The list of one work: the caller's own (studentId null) or, for a teacher of it, a student's. */
    async list(
      token: string,
      assignmentId: string,
      studentId: string | null,
    ): Promise<WorkSourceList> {
      if (!isId(assignmentId) || (studentId !== null && !isId(studentId)))
        return { status: "not_found" };
      try {
        return await withActor(token, async (tx) => {
          const { rows } = await tx.query<WorkSourceRow>(LIST_SQL, [assignmentId, studentId]);
          return { status: "read", sources: rows.map(sourceOf) };
        });
      } catch (error) {
        const refusal = refusalOf(codeOf(error));
        if (refusal !== undefined) return refusal;
        throw error;
      }
    },
    /** The student of the work adds or changes an own source. */
    async save(token: string, input: WorkSourceInput): Promise<WorkSourceSave> {
      const checked = checkedOf(input);
      if (checked === undefined) return { status: "invalid_input" };
      const { record, doi, isbn, undated } = checked;
      return save(
        token,
        SAVE_SQL,
        [input.assignmentId, JSON.stringify(record), doi, isbn, undated],
        record.id,
      );
    },
    /** A teacher of the work adds or changes a recommended or required source. */
    async saveForStudent(
      token: string,
      input: WorkSourceInput & {
        readonly studentId: string;
        readonly requirement: WorkSourceRequirement;
      },
    ): Promise<WorkSourceSave> {
      const checked = checkedOf(input);
      const { studentId, requirement } = input;
      if (
        checked === undefined ||
        !isId(studentId) ||
        (requirement !== "recommended" && requirement !== "required")
      ) {
        return { status: "invalid_input" };
      }
      const { record, doi, isbn, undated } = checked;
      const params = [
        input.assignmentId,
        studentId,
        JSON.stringify(record),
        requirement,
        doi,
        isbn,
        undated,
      ];
      return save(token, TEACHER_SAVE_SQL, params, record.id);
    },
    /** The student of the work removes an own source. */
    async remove(token: string, assignmentId: string, sourceId: string): Promise<WorkSourceRemove> {
      if (!isId(assignmentId) || !isId(sourceId)) return { status: "not_found" };
      return remove(token, REMOVE_SQL, [assignmentId, sourceId]);
    },
    /** A teacher of the work removes a recommended or required source. */
    async removeForStudent(
      token: string,
      assignmentId: string,
      studentId: string,
      sourceId: string,
    ): Promise<WorkSourceRemove> {
      if (!isId(assignmentId) || !isId(studentId) || !isId(sourceId))
        return { status: "not_found" };
      return remove(token, TEACHER_REMOVE_SQL, [assignmentId, studentId, sourceId]);
    },
  };
}

export type WorkSources = ReturnType<typeof createWorkSources>;

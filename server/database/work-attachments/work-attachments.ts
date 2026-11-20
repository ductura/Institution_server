// The port of a work's attachments (SRV-10B; migration 20261120233000), the
// images of the document (schema v4 §5). The student of the work records an
// attachment whose bytes the server has already stored; the student and a
// reader of the work list them and read one by id. Every write goes through
// an RPC, never the table, and the student and institution come only from the
// session. An attachment is append-only: there is no change and no removal.
//
// The input is checked here before the database checks it again: PNG or
// JPEG, 1 byte to 5 MiB, the SHA-256 as 64 lowercase hex digits, a storage
// reference of printable ASCII without spaces (at most 1024) and both pixel
// sizes or neither. The same bytes added again to the same work answer the
// row already there (`created: false`). Refusals are outcomes, never thrown:
// ZD401 unauthorized, ZD403 not_found (one answer for every refusal, C-23),
// ZD422 invalid_input (also a work at its bound of 200 attachments or
// 100 MiB). Anything else is thrown.
import type { WithActor } from "../index.ts";

export const WORK_ATTACHMENT_MEDIA_TYPES = ["image/png", "image/jpeg"] as const;
export type WorkAttachmentMediaType = (typeof WORK_ATTACHMENT_MEDIA_TYPES)[number];
export const WORK_ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;

export type WorkAttachment = {
  readonly id: string;
  readonly mediaType: WorkAttachmentMediaType;
  readonly byteSize: number;
  readonly sha256: string;
  readonly pixelWidth: number | null;
  readonly pixelHeight: number | null;
  readonly storageRef: string;
  readonly createdAt: string;
};

/** One attachment read by id, with the work it belongs to. */
export type WorkAttachmentRecord = WorkAttachment & {
  readonly assignmentId: string;
  readonly studentId: string;
};

export type WorkAttachmentInput = {
  readonly assignmentId: string;
  readonly mediaType: string;
  readonly byteSize: number;
  readonly sha256: string;
  readonly storageRef: string;
  readonly pixelWidth?: number | null;
  readonly pixelHeight?: number | null;
};

type Refusal = { readonly status: "unauthorized" | "not_found" };
export type WorkAttachmentAdd =
  | { readonly status: "added"; readonly attachment: WorkAttachment; readonly created: boolean }
  | Refusal
  | { readonly status: "invalid_input" };
export type WorkAttachmentList =
  { readonly status: "read"; readonly attachments: WorkAttachment[] } | Refusal;
export type WorkAttachmentRead =
  { readonly status: "read"; readonly attachment: WorkAttachmentRecord } | Refusal;

const FIELDS =
  'id, media_type AS "mediaType", byte_size AS "byteSize", sha256, pixel_width AS "pixelWidth", ' +
  'pixel_height AS "pixelHeight", storage_ref AS "storageRef", created_at AS "createdAt"';
const ADD_SQL = `SELECT ${FIELDS}, created
  FROM institution.add_work_attachment($1::uuid, $2::text, $3::integer, $4::text, $5::text, $6::integer, $7::integer)`;
const LIST_SQL = `SELECT ${FIELDS} FROM institution.work_attachments($1::uuid, $2::uuid)`;
const READ_SQL = `SELECT ${FIELDS}, assignment_id AS "assignmentId", student_id AS "studentId"
  FROM institution.read_work_attachment($1::uuid)`;

const LOWER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const STORAGE_REF = /^[!-~]{1,1024}$/u;

type Row = {
  id: unknown;
  mediaType: unknown;
  byteSize: unknown;
  sha256: unknown;
  pixelWidth: unknown;
  pixelHeight: unknown;
  storageRef: unknown;
  createdAt: unknown;
  created?: unknown;
  assignmentId?: unknown;
  studentId?: unknown;
};

const isId = (value: unknown): value is string =>
  typeof value === "string" && LOWER_UUID.test(value);

const isWhole = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;

export function isWorkAttachmentMediaType(value: unknown): value is WorkAttachmentMediaType {
  return (WORK_ATTACHMENT_MEDIA_TYPES as readonly unknown[]).includes(value);
}

/** Both pixel sizes from 1 to 20000, or neither. */
function pixelsOk(width: unknown, height: unknown): boolean {
  if (width === null && height === null) return true;
  return isWhole(width, 1, 20000) && isWhole(height, 1, 20000);
}

function checkedOf(input: WorkAttachmentInput): unknown[] | undefined {
  const pixelWidth = input.pixelWidth ?? null;
  const pixelHeight = input.pixelHeight ?? null;
  if (
    !isId(input.assignmentId) ||
    !isWorkAttachmentMediaType(input.mediaType) ||
    !isWhole(input.byteSize, 1, WORK_ATTACHMENT_MAX_BYTES) ||
    typeof input.sha256 !== "string" ||
    !SHA256.test(input.sha256) ||
    typeof input.storageRef !== "string" ||
    !STORAGE_REF.test(input.storageRef) ||
    !pixelsOk(pixelWidth, pixelHeight)
  ) {
    return undefined;
  }
  return [
    input.assignmentId,
    input.mediaType,
    input.byteSize,
    input.sha256,
    input.storageRef,
    pixelWidth,
    pixelHeight,
  ];
}

function instantOf(value: unknown): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("invalid work attachment timestamp");
  }
  return value.toISOString();
}

function attachmentOf(row: Row): WorkAttachment {
  if (
    typeof row.id !== "string" ||
    !UUID_V4.test(row.id) ||
    !isWorkAttachmentMediaType(row.mediaType) ||
    !isWhole(row.byteSize, 1, WORK_ATTACHMENT_MAX_BYTES) ||
    typeof row.sha256 !== "string" ||
    !SHA256.test(row.sha256) ||
    typeof row.storageRef !== "string" ||
    !STORAGE_REF.test(row.storageRef) ||
    !pixelsOk(row.pixelWidth, row.pixelHeight)
  ) {
    throw new Error("invalid work attachment row");
  }
  return {
    id: row.id,
    mediaType: row.mediaType,
    byteSize: row.byteSize,
    sha256: row.sha256,
    pixelWidth: row.pixelWidth as number | null,
    pixelHeight: row.pixelHeight as number | null,
    storageRef: row.storageRef,
    createdAt: instantOf(row.createdAt),
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

export function createWorkAttachments(withActor: WithActor) {
  return {
    /** The student of the work records an attachment whose bytes are already stored. */
    async add(token: string, input: WorkAttachmentInput): Promise<WorkAttachmentAdd> {
      const params = checkedOf(input);
      if (params === undefined) return { status: "invalid_input" };
      try {
        return await withActor(token, async (tx) => {
          const { rows } = await tx.query<Row>(ADD_SQL, params);
          const row = rows[0];
          // Confirmed inside the transaction, so an answer that is not this
          // attachment rolls the write back.
          if (
            rows.length !== 1 ||
            row === undefined ||
            row.sha256 !== input.sha256 ||
            typeof row.created !== "boolean"
          ) {
            throw new Error("unconfirmed work attachment");
          }
          return { status: "added", attachment: attachmentOf(row), created: row.created };
        });
      } catch (error) {
        const code = codeOf(error);
        if (code === "ZD422") return { status: "invalid_input" };
        const refusal = refusalOf(code);
        if (refusal !== undefined) return refusal;
        throw error;
      }
    },
    /** The attachments of one work: the caller's own (studentId null) or, for a reader of it, a student's. */
    async list(
      token: string,
      assignmentId: string,
      studentId: string | null,
    ): Promise<WorkAttachmentList> {
      if (!isId(assignmentId) || (studentId !== null && !isId(studentId)))
        return { status: "not_found" };
      try {
        return await withActor(token, async (tx) => {
          const { rows } = await tx.query<Row>(LIST_SQL, [assignmentId, studentId]);
          return { status: "read", attachments: rows.map(attachmentOf) };
        });
      } catch (error) {
        const refusal = refusalOf(codeOf(error));
        if (refusal !== undefined) return refusal;
        throw error;
      }
    },
    /** One attachment by id, for the student of its work or a reader of it. */
    async read(token: string, attachmentId: string): Promise<WorkAttachmentRead> {
      if (!isId(attachmentId)) return { status: "not_found" };
      try {
        return await withActor(token, async (tx) => {
          const { rows } = await tx.query<Row>(READ_SQL, [attachmentId]);
          const row = rows[0];
          if (
            rows.length !== 1 ||
            row === undefined ||
            row.id !== attachmentId ||
            !isId(row.assignmentId) ||
            !isId(row.studentId)
          ) {
            throw new Error("invalid work attachment row");
          }
          return {
            status: "read",
            attachment: {
              ...attachmentOf(row),
              assignmentId: row.assignmentId,
              studentId: row.studentId,
            },
          };
        });
      } catch (error) {
        const refusal = refusalOf(codeOf(error));
        if (refusal !== undefined) return refusal;
        throw error;
      }
    },
  };
}

export type WorkAttachments = ReturnType<typeof createWorkAttachments>;

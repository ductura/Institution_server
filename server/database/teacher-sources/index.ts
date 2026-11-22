// SRV-1605 (Ductus#2052; WEB-2133): the database port of the guidance of a
// teacher on sources (migration 20261213100500): the recommendation of a source
// on a work, the required literature of a course, the request for a proof, the
// mark that the literature was reviewed, and the proofs a teacher reads. One
// withActor transaction per call over the RPCs (app.teacher_*,
// app.course_literature_*, app.student_proof_requests), which decide who may:
// the holder of the course and the mentor write, every other reader reads.
// Refusals are outcomes, never thrown: ZD401 unauthorized, ZD403 not_found (one
// answer for every refusal, C-23), ZD409 conflict, ZD422 invalid_input. Anything
// else is thrown. The answers of the RPCs are JSON; the route checks them
// against its contract before they leave, so this port only checks their outline.
import {
  isSourceProofJpeg,
  isSourceProofText,
  SOURCE_PROOF_NOTE_MAX,
  SOURCE_PROOF_PAGE_MAX,
  type SourceProof,
} from "../source-proofs/index.ts";
import { isWorkSourceDoi, isWorkSourceIsbn } from "../work-sources/index.ts";
import type { ActorTransaction, WithActor } from "../index.ts";

export type Refusal = { readonly status: "unauthorized" | "not_found" };
export type Outcome<T> = { readonly status: "ok"; readonly value: T } | Refusal;
export type WriteOutcome<T> = Outcome<T> | { readonly status: "invalid_input" | "conflict" };

export type SourceGuidanceInput = {
  readonly record: unknown;
  readonly doi?: string | null | undefined;
  readonly isbn?: string | null | undefined;
  readonly undated?: boolean | undefined;
};
export type RecommendationInput = SourceGuidanceInput & {
  readonly requirement: "recommended" | "required";
};
export type ProofRequestInput = { readonly instruction: string; readonly dueAt: string };

export type ProofImage = { readonly image: Buffer };

const LOWER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const isId = (value: unknown): value is string =>
  typeof value === "string" && LOWER_UUID.test(value);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function codeOf(error: unknown): unknown {
  try {
    return error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
  } catch {
    return undefined;
  }
}

function refusalOf(error: unknown): Refusal | undefined {
  const code = codeOf(error);
  if (code === "ZD401") return { status: "unauthorized" };
  if (code === "ZD403") return { status: "not_found" };
  return undefined;
}

function writeRefusalOf(error: unknown): WriteOutcome<never> {
  const code = codeOf(error);
  if (code === "ZD422") return { status: "invalid_input" };
  if (code === "ZD409") return { status: "conflict" };
  const refusal = refusalOf(error);
  if (refusal === undefined) throw error;
  return refusal;
}

function readRefusalOf(error: unknown): Refusal {
  const refusal = refusalOf(error);
  if (refusal === undefined) throw error;
  return refusal;
}

/** The first column of the single row, as the JSON the RPC returned. */
function jsonOf(rows: readonly Record<string, unknown>[], column: string): Record<string, unknown> {
  const value = rows.length === 1 ? rows[0]?.[column] : undefined;
  if (!isRecord(value)) throw new Error(`unexpected answer of ${column}`);
  return value;
}

function flagOf(rows: readonly Record<string, unknown>[], column: string): boolean {
  const value = rows.length === 1 ? rows[0]?.[column] : undefined;
  if (typeof value !== "boolean") throw new Error(`unexpected answer of ${column}`);
  return value;
}

type Checked = {
  readonly record: string;
  readonly doi: string | null;
  readonly isbn: string | null;
  readonly undated: boolean;
};

function checkedOf(input: SourceGuidanceInput): Checked | undefined {
  const doi = input.doi ?? null;
  const isbn = input.isbn ?? null;
  const undated = input.undated ?? false;
  if (!isRecord(input.record) || typeof undated !== "boolean") return undefined;
  if ((doi !== null && !isWorkSourceDoi(doi)) || (isbn !== null && !isWorkSourceIsbn(isbn))) {
    return undefined;
  }
  return { record: JSON.stringify(input.record), doi, isbn, undated };
}

type ProofRow = { id: unknown; page: unknown; note: unknown };

function proofOf(row: ProofRow): SourceProof {
  if (
    !isId(row.id) ||
    !isSourceProofText(row.page, SOURCE_PROOF_PAGE_MAX, false) ||
    (row.note !== null && !isSourceProofText(row.note, SOURCE_PROOF_NOTE_MAX, true))
  ) {
    throw new Error("invalid source proof row");
  }
  return { id: row.id, page: row.page, note: row.note };
}

const WORK_SQL =
  'SELECT assignment_id AS "assignmentId", student_id AS "studentId", is_owner AS "isOwner" FROM app.origin_work_access($1::text, false)';
const PROOFS_SQL =
  "SELECT id, page, note FROM institution.source_proofs($1::uuid, $2::uuid, $3::uuid)";
const IMAGE_SQL =
  "SELECT image FROM institution.read_source_proof_image($1::uuid, $2::uuid, $3::uuid, $4::uuid)";

export function createTeacherSources(withActor: WithActor) {
  async function read<T>(
    token: string,
    run: (tx: ActorTransaction) => Promise<T>,
  ): Promise<Outcome<T>> {
    try {
      return { status: "ok", value: await withActor(token, run) };
    } catch (error) {
      return readRefusalOf(error);
    }
  }
  async function write<T>(
    token: string,
    run: (tx: ActorTransaction) => Promise<T>,
  ): Promise<WriteOutcome<T>> {
    try {
      return { status: "ok", value: await withActor(token, run) };
    } catch (error) {
      return writeRefusalOf(error);
    }
  }
  /** The work behind a document id for a teacher: another's work the caller reads. */
  async function workOf(
    tx: ActorTransaction,
    documentId: string,
  ): Promise<{ assignmentId: string; studentId: string }> {
    const { rows } = await tx.query<Record<string, unknown>>(WORK_SQL, [documentId]);
    const row = rows[0];
    if (rows.length !== 1 || row === undefined || !isId(row.assignmentId) || !isId(row.studentId)) {
      throw Object.assign(new Error("forbidden"), { code: "ZD403" });
    }
    // The student of the work reads the own proofs through the student routes.
    if (row.isOwner !== false) throw Object.assign(new Error("forbidden"), { code: "ZD403" });
    return { assignmentId: row.assignmentId, studentId: row.studentId };
  }

  return {
    /** The sources, the proof requests and the mark of a work, for a reader of it. */
    guidance: (token: string, documentId: string) =>
      read(token, async (tx) =>
        jsonOf(
          (
            await tx.query<Record<string, unknown>>(
              "SELECT app.teacher_source_guidance($1::text) AS answer",
              [documentId],
            )
          ).rows,
          "answer",
        ),
      ),
    /** The writer recommends or requires a source on the work (s2Rec). */
    recommend(token: string, documentId: string, input: RecommendationInput) {
      const checked = checkedOf(input);
      if (checked === undefined)
        return Promise.resolve<WriteOutcome<never>>({ status: "invalid_input" });
      return write(token, async (tx) =>
        jsonOf(
          (
            await tx.query<Record<string, unknown>>(
              "SELECT app.teacher_source_recommend($1::text, $2::jsonb, $3::text, $4::text, $5::text, $6::boolean) AS answer",
              [
                documentId,
                checked.record,
                input.requirement,
                checked.doi,
                checked.isbn,
                checked.undated,
              ],
            )
          ).rows,
          "answer",
        ),
      );
    },
    /** The writer removes a recommended or required source (s2RecDel); false when there was none. */
    unrecommend: (token: string, documentId: string, sourceId: string) =>
      write(token, async (tx) =>
        flagOf(
          (
            await tx.query<Record<string, unknown>>(
              "SELECT app.teacher_source_unrecommend($1::text, $2::uuid) AS done",
              [documentId, sourceId],
            )
          ).rows,
          "done",
        ),
      ),
    /** The writer sets the request for a proof of a source (s2Req). */
    putProofRequest: (
      token: string,
      documentId: string,
      sourceId: string,
      input: ProofRequestInput,
    ) =>
      write(token, async (tx) =>
        jsonOf(
          (
            await tx.query<Record<string, unknown>>(
              "SELECT app.teacher_proof_request_put($1::text, $2::uuid, $3::text, $4::timestamptz) AS answer",
              [documentId, sourceId, input.instruction, input.dueAt],
            )
          ).rows,
          "answer",
        ),
      ),
    /** The writer closes the open request of a source (s2ReqDel); false when there was none. */
    closeProofRequest: (token: string, documentId: string, sourceId: string) =>
      write(token, async (tx) =>
        flagOf(
          (
            await tx.query<Record<string, unknown>>(
              "SELECT app.teacher_proof_request_close($1::text, $2::uuid) AS done",
              [documentId, sourceId],
            )
          ).rows,
          "done",
        ),
      ),
    /** The writer marks the literature of the work as reviewed (litSeen). */
    markLiteratureSeen: (token: string, documentId: string) =>
      write(token, async (tx) => {
        const { rows } = await tx.query<Record<string, unknown>>(
          'SELECT app.teacher_literature_seen_put($1::text) AS "seenAt"',
          [documentId],
        );
        const seenAt = rows.length === 1 ? rows[0]?.seenAt : undefined;
        if (typeof seenAt !== "string") throw new Error("unexpected answer of the literature mark");
        return seenAt;
      }),
    /** The proofs of one source of a work, for a reader of it. */
    proofs: (token: string, documentId: string, sourceId: string) =>
      read(token, async (tx) => {
        const work = await workOf(tx, documentId);
        const { rows } = await tx.query<ProofRow>(PROOFS_SQL, [
          work.assignmentId,
          sourceId,
          work.studentId,
        ]);
        return rows.map(proofOf);
      }),
    /** The JPEG bytes of one proof of a source of a work, for a reader of it. */
    image: (token: string, documentId: string, sourceId: string, proofId: string) =>
      read(token, async (tx): Promise<ProofImage> => {
        const work = await workOf(tx, documentId);
        const { rows } = await tx.query<{ image: unknown }>(IMAGE_SQL, [
          work.assignmentId,
          sourceId,
          proofId,
          work.studentId,
        ]);
        const image = rows[0]?.image;
        if (rows.length !== 1 || !Buffer.isBuffer(image) || !isSourceProofJpeg(image)) {
          throw new Error("invalid source proof image");
        }
        return { image };
      }),
    /** The required literature of a course, for its teachers and its students. */
    courseLiterature: (token: string, courseId: string) =>
      read(token, async (tx) =>
        jsonOf(
          (
            await tx.query<Record<string, unknown>>(
              "SELECT app.course_literature_read($1::uuid) AS answer",
              [courseId],
            )
          ).rows,
          "answer",
        ),
      ),
    /** The holder adds a required source to the course or changes one (s2ObNew). */
    putCourseSource(token: string, courseId: string, input: SourceGuidanceInput) {
      const checked = checkedOf(input);
      if (checked === undefined)
        return Promise.resolve<WriteOutcome<never>>({ status: "invalid_input" });
      return write(token, async (tx) =>
        jsonOf(
          (
            await tx.query<Record<string, unknown>>(
              "SELECT app.course_literature_put($1::uuid, $2::jsonb, $3::text, $4::text, $5::boolean) AS answer",
              [courseId, checked.record, checked.doi, checked.isbn, checked.undated],
            )
          ).rows,
          "answer",
        ),
      );
    },
    /** The holder removes a required source of the course (s2ObDel); false when there was none. */
    deleteCourseSource: (token: string, courseId: string, sourceId: string) =>
      write(token, async (tx) =>
        flagOf(
          (
            await tx.query<Record<string, unknown>>(
              "SELECT app.course_literature_delete($1::uuid, $2::uuid) AS done",
              [courseId, sourceId],
            )
          ).rows,
          "done",
        ),
      ),
    /** The proof requests of the caller's own work. */
    studentProofRequests: (token: string, assignmentId: string) =>
      read(token, async (tx) =>
        jsonOf(
          (
            await tx.query<Record<string, unknown>>(
              "SELECT app.student_proof_requests($1::uuid) AS answer",
              [assignmentId],
            )
          ).rows,
          "answer",
        ),
      ),
  };
}

export type TeacherSources = ReturnType<typeof createTeacherSources>;

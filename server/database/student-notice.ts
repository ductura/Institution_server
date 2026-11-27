// SRV-NG (Ductus#2028 c.7019543739): the notice of the current version of an
// assignment for a student of its course or of its mentorship
// (SRV-MENTOR-NOTICE, Ductus#2055), for student.notice.get. One withActor
// transaction under RLS (the web role reads assignment, assignment_version,
// notice_read and notice_acknowledgment through their read policies), the
// caller only from the session. An assignment of another course or
// mentorship, an unknown one, an ended mentorship and a removed student read
// NOT_FOUND alike (C-23); a session that no longer stands is UNAUTHENTICATED.
// The row is checked against the contract's shape; one it cannot vouch for is
// ROW_MALFORMED, never a partial answer. Writes nothing.
import type { AppError, Result } from "../domain/index.ts";

import type { WithActor } from "./with-actor.ts";

const error = (code: string, messageKey: string): AppError => ({ code, messageKey });

export const STUDENT_NOTICE_UNAUTHENTICATED = error(
  "STUDENT_NOTICE_UNAUTHENTICATED",
  "studentNotice.unauthenticated",
);
export const STUDENT_NOTICE_NOT_FOUND = error(
  "STUDENT_NOTICE_NOT_FOUND",
  "studentNotice.not_found",
);
export const STUDENT_NOTICE_ROW_MALFORMED = error(
  "STUDENT_NOTICE_ROW_MALFORMED",
  "studentNotice.row_malformed",
);
export const STUDENT_NOTICE_DATABASE_ERROR = error(
  "STUDENT_NOTICE_DATABASE_ERROR",
  "studentNotice.database_error",
);
export const STUDENT_NOTICE_ERRORS: readonly AppError[] = [
  STUDENT_NOTICE_UNAUTHENTICATED,
  STUDENT_NOTICE_NOT_FOUND,
  STUDENT_NOTICE_ROW_MALFORMED,
  STUDENT_NOTICE_DATABASE_ERROR,
];

/** The notice as stored; instants as Date.toISOString writes them. */
export type StoredNotice = {
  assignmentId: string;
  versionNo: number;
  title: string;
  instructions: string;
  workType: string;
  opensAt: string;
  dueAt: string;
  aiPolicy: string;
  aiPurposes: string[];
  evidenceProfile: string;
  wordMin: number | null;
  wordMax: number | null;
  readAt: string | null;
  acknowledgedAt: string | null;
  /** The purpose catalog of the version (SRV-ASIST-CITANJE); not in the fingerprint. */
  purposeCatalogVersion: number;
  /** The assistant only summarises (SRV-EDI-R08); not in the fingerprint. */
  aiSummaryOnly: boolean;
  /**
   * F4-STU-R11-SRV: the content of the version before the current one, for
   * "what changed" (P-16); null when the current version is the first.
   */
  previousVersion: PreviousNoticeVersion | null;
};

/** The fingerprint content of one earlier version of the notice. */
export type PreviousNoticeVersion = Pick<
  StoredNotice,
  | "versionNo"
  | "title"
  | "instructions"
  | "workType"
  | "opensAt"
  | "dueAt"
  | "aiPolicy"
  | "aiPurposes"
  | "evidenceProfile"
  | "wordMin"
  | "wordMax"
>;

export type StudentNoticeReader = {
  read(token: string | undefined, assignmentId: string): Promise<Result<StoredNotice>>;
};

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const ACTOR_SQL = "SELECT app.current_user_id() AS user_id";
// The caller must be a student of the assignment: of its course (an open
// student membership) or of its open mentorship (SRV-MENTOR-NOTICE). It is
// asked explicitly through actor_assignment_ids('{student}'), the same helper
// the read policies use: RLS alone would also show the assignment to its
// teacher or mentor. F4-STU-R11-SRV: the highest version below the current
// one comes along as prev_* (all null for a first version); the same read
// policy of assignment_version already shows every version to the student.
const NOTICE_SQL = `SELECT a.id AS assignment_id, v.version_no, v.title, v.instructions, v.work_type,
    v.opens_at, v.due_at, v.ai_policy, v.ai_purposes, v.evidence_profile, v.word_min, v.word_max,
    v.purpose_catalog_version, a.ai_summary_only,
    p.version_no AS prev_version_no, p.title AS prev_title, p.instructions AS prev_instructions,
    p.work_type AS prev_work_type, p.opens_at AS prev_opens_at, p.due_at AS prev_due_at,
    p.ai_policy AS prev_ai_policy, p.ai_purposes AS prev_ai_purposes,
    p.evidence_profile AS prev_evidence_profile, p.word_min AS prev_word_min,
    p.word_max AS prev_word_max,
    (SELECT r.read_at FROM institution.notice_read r
      WHERE r.assignment_id = a.id AND r.student_id = (SELECT app.current_user_id())) AS read_at,
    (SELECT k.acknowledged_at FROM institution.notice_acknowledgment k
      WHERE k.assignment_id = a.id AND k.version_no = v.version_no
        AND k.student_id = (SELECT app.current_user_id())) AS acknowledged_at
  FROM institution.assignment a
  JOIN institution.assignment_version v ON v.assignment_id = a.id AND v.version_no = a.current_version
  LEFT JOIN institution.assignment_version p ON p.assignment_id = a.id
    AND p.version_no = (SELECT max(q.version_no) FROM institution.assignment_version q
      WHERE q.assignment_id = a.id AND q.version_no < a.current_version)
  WHERE a.id = $1::uuid
    AND a.id = ANY ((SELECT institution.actor_assignment_ids('{student}'))::uuid[])`;

const fail = (e: AppError): { ok: false; error: AppError } => ({ ok: false, error: e });
const own = (row: object, key: string): unknown =>
  Object.hasOwn(row, key) ? (row as Record<string, unknown>)[key] : undefined;

function codeOf(thrown: unknown): string | undefined {
  try {
    const code = thrown && typeof thrown === "object" && "code" in thrown ? thrown.code : undefined;
    return typeof code === "string" ? code : undefined;
  } catch {
    return undefined;
  }
}

function instant(value: unknown): string | null | undefined {
  if (value === null) return null;
  return value instanceof Date && Number.isFinite(value.getTime())
    ? value.toISOString()
    : undefined;
}

const bound = (value: unknown): number | null | undefined =>
  value === null
    ? null
    : Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 1_000_000
      ? (value as number)
      : undefined;

/** The version content under the column prefix, or null when any part does not check. */
function versionOf(row: object, prefix: string): PreviousNoticeVersion | null {
  const at = (key: string): unknown => own(row, prefix + key);
  const [versionNo, title, instructions, workType, aiPolicy, aiPurposes, evidenceProfile] = [
    "version_no",
    "title",
    "instructions",
    "work_type",
    "ai_policy",
    "ai_purposes",
    "evidence_profile",
  ].map(at);
  const [opensAt, dueAt] = [instant(at("opens_at")), instant(at("due_at"))];
  const [wordMin, wordMax] = [bound(at("word_min")), bound(at("word_max"))];
  if (
    !Number.isInteger(versionNo) ||
    (versionNo as number) < 1 ||
    (versionNo as number) > 2_147_483_647 ||
    typeof title !== "string" ||
    title === "" ||
    typeof instructions !== "string" ||
    typeof workType !== "string" ||
    typeof aiPolicy !== "string" ||
    typeof evidenceProfile !== "string" ||
    !Array.isArray(aiPurposes) ||
    !aiPurposes.every((p) => typeof p === "string") ||
    typeof opensAt !== "string" ||
    typeof dueAt !== "string" ||
    wordMin === undefined ||
    wordMax === undefined
  ) {
    return null;
  }
  return {
    versionNo: versionNo as number,
    title,
    instructions,
    workType,
    opensAt,
    dueAt,
    aiPolicy,
    aiPurposes: aiPurposes as string[],
    evidenceProfile,
    wordMin,
    wordMax,
  };
}

const PREVIOUS_COLUMNS = [
  "version_no",
  "title",
  "instructions",
  "work_type",
  "opens_at",
  "due_at",
  "ai_policy",
  "ai_purposes",
  "evidence_profile",
  "word_min",
  "word_max",
].map((key) => `prev_${key}`);

/** The one row as a notice, or null when any part does not check. */
export function noticeOf(rows: unknown): StoredNotice | null {
  if (!Array.isArray(rows) || rows.length !== 1 || typeof rows[0] !== "object" || rows[0] === null)
    return null;
  const row = rows[0] as object;
  const current = versionOf(row, "");
  const assignmentId = own(row, "assignment_id");
  const readAt = instant(own(row, "read_at"));
  const acknowledgedAt = instant(own(row, "acknowledged_at"));
  const catalog = own(row, "purpose_catalog_version");
  const summaryOnly = own(row, "ai_summary_only");
  // A first version has no previous one: every prev_* column is null. Any
  // other mix, or an absent column, is a row the read cannot vouch for.
  const first = PREVIOUS_COLUMNS.every((key) => own(row, key) === null);
  const previous = first ? null : versionOf(row, "prev_");
  if (
    current === null ||
    typeof assignmentId !== "string" ||
    !UUID.test(assignmentId) ||
    readAt === undefined ||
    acknowledgedAt === undefined ||
    typeof summaryOnly !== "boolean" ||
    !Number.isInteger(catalog) ||
    (catalog as number) < 1 ||
    (catalog as number) > 2_147_483_647 ||
    (!first && (previous === null || previous.versionNo >= current.versionNo))
  ) {
    return null;
  }
  return {
    assignmentId,
    ...current,
    readAt,
    acknowledgedAt,
    purposeCatalogVersion: catalog as number,
    aiSummaryOnly: summaryOnly,
    previousVersion: previous,
  };
}

export function createStudentNoticeReader(withActor: WithActor): StudentNoticeReader {
  return {
    async read(token, assignmentId) {
      if (token === undefined || !TOKEN.test(token)) return fail(STUDENT_NOTICE_UNAUTHENTICATED);
      if (!UUID.test(assignmentId)) return fail(STUDENT_NOTICE_NOT_FOUND);
      let answer: { actor: unknown; rows: unknown };
      try {
        answer = await withActor(token, async (tx) => {
          const actor = (await tx.query(ACTOR_SQL, [])).rows;
          const rows = (await tx.query(NOTICE_SQL, [assignmentId])).rows;
          return { actor, rows };
        });
      } catch (thrown) {
        return fail(
          codeOf(thrown) === "ZD401"
            ? STUDENT_NOTICE_UNAUTHENTICATED
            : STUDENT_NOTICE_DATABASE_ERROR,
        );
      }
      const actor =
        Array.isArray(answer.actor) && answer.actor.length === 1
          ? own(answer.actor[0] as object, "user_id")
          : undefined;
      if (actor === null || actor === undefined) return fail(STUDENT_NOTICE_UNAUTHENTICATED);
      if (Array.isArray(answer.rows) && answer.rows.length === 0)
        return fail(STUDENT_NOTICE_NOT_FOUND);
      const notice = noticeOf(answer.rows);
      return notice === null ? fail(STUDENT_NOTICE_ROW_MALFORMED) : { ok: true, value: notice };
    },
  };
}

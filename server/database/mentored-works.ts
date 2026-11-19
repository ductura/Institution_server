// The works a teacher mentors (contracts teacher.mentorships.get and
// teacher.mentorship.get). Port of Ductus src/server/institution/mentored-works.ts
// at 078c780 (SQL, mentoredWorkOf, mentoredWorksOf, query, readMentoredWorks
// and readMentoredWork) without a change of logic; changes are of form: the
// token's shape is the route's (liveSessionTokenFromCookie), a failure is an
// outcome whose reason names no SQLSTATE, and nothing is logged here. Who
// asks comes only from the session bound into withActor; the database
// decides who sees which mentorship (RLS mentorship_read and
// institution.actor_mentorship_role). The row RLS also shows a student their
// own mentorships, so the read keeps only those where the actor is the
// mentor. Anyone else, another institution's mentorship, an ended one, an
// unknown and a malformed id read the same: an empty list and not_found.
import type { WithActor } from "./with-actor.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NAME_MAX = 255;
/** The work types of institution.mentorship. */
const WORK_TYPES = new Set([
  "bachelor_thesis",
  "master_thesis",
  "specialist_thesis",
  "doctoral_thesis",
]);

export type MentoredWorkType =
  | "bachelor_thesis"
  | "master_thesis"
  | "specialist_thesis"
  | "doctoral_thesis";
export type MentoredWorkState = "not_started" | "in_progress" | "submitted";

export type MentoredWork = {
  readonly mentorshipId: string;
  readonly assignmentId: string;
  /** Null until the student starts the work. */
  readonly documentId: string | null;
  /** Null when the account has no name pair (#757 D1); never a stand-in. */
  readonly student: { readonly givenName: string; readonly familyName: string } | null;
  readonly title: string;
  readonly workType: MentoredWorkType;
  readonly workState: MentoredWorkState;
};

type Failure = { readonly status: "unauthenticated" | "unavailable"; readonly reason?: string };
export type MentoredWorksOutcome =
  | { readonly status: "ok"; readonly works: readonly MentoredWork[] }
  | Failure;
export type MentoredWorkOutcome =
  | { readonly status: "ok"; readonly work: MentoredWork }
  | { readonly status: "not_found" }
  | Failure;

export type MentoredWorksReader = {
  readMentoredWorks(token: string): Promise<MentoredWorksOutcome>;
  readMentoredWork(token: string, mentorshipId: string): Promise<MentoredWorkOutcome>;
};

type Row = Record<string, unknown>;

// One row per mentorship with an assignment: its current version, and the
// student's name, document and submission from the functions that already
// decide for every assignment (#947). A second row for a mentorship would
// mean a second assignment or document: the parser refuses it.
const SQL = `
SELECT m.id::text AS mentorship_id, a.id::text AS assignment_id, v.title, m.work_type,
       w.document_id, n.given_name, n.family_name, s.submitted
  FROM institution.mentorship m
  JOIN institution.assignment a ON a.mentorship_id = m.id AND a.institution_id = m.institution_id
  JOIN institution.assignment_version v ON v.assignment_id = a.id AND v.version_no = a.current_version
  LEFT JOIN LATERAL (SELECT x.given_name, x.family_name FROM app.teacher_assignment_names(a.id) x
                      WHERE x.student_id = m.student_id) n ON true
  LEFT JOIN LATERAL (SELECT x.document_id FROM app.assignment_works(a.id) x
                      WHERE x.student_id = m.student_id) w ON true
  LEFT JOIN LATERAL (SELECT x.submitted FROM app.assignment_submissions(a.id) x
                      WHERE x.student_id = m.student_id) s ON true
 WHERE m.institution_id = app.current_institution_id()
   AND m.ended_at IS NULL
   AND institution.actor_mentorship_role(m.id) = 'teacher'
   AND ($1::uuid IS NULL OR m.id = $1::uuid)
 ORDER BY m.started_at DESC, m.id`;
const ACTOR_SQL = "SELECT user_id, institution_id FROM app.current_actor()";

/** The code of a database error; a getter or Proxy that throws has none. */
function codeOf(thrown: unknown): unknown {
  try {
    return thrown && typeof thrown === "object" && "code" in thrown ? thrown.code : undefined;
  } catch {
    return undefined;
  }
}

function isName(value: unknown): value is string {
  // Code points, as length() in the database counts (F-149).
  return typeof value === "string" && value.length >= 1 && [...value].length <= NAME_MAX;
}

/** A document id as `evidence.document` allows it: 1 to 256 characters, trimmed, no control characters. */
function isDocumentId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 256 &&
    value === value.trim() &&
    !/[\u0000-\u001f\u007f-\u009f]/.test(value)
  );
}

/** One row as a mentored work, or null when it is not what the read returns. */
export function mentoredWorkOf(row: Row): MentoredWork | null {
  const {
    mentorship_id: mentorshipId,
    assignment_id: assignmentId,
    title,
    work_type: workType,
  } = row;
  if (
    typeof mentorshipId !== "string" ||
    !UUID.test(mentorshipId) ||
    typeof assignmentId !== "string" ||
    !UUID.test(assignmentId) ||
    typeof title !== "string" ||
    title === "" ||
    typeof workType !== "string" ||
    !WORK_TYPES.has(workType)
  ) {
    return null;
  }
  let student: MentoredWork["student"];
  if (isName(row.given_name) && isName(row.family_name)) {
    student = { givenName: row.given_name, familyName: row.family_name };
  } else if (row.given_name === null && row.family_name === null) {
    student = null;
  } else {
    return null;
  }
  const documentId = row.document_id;
  if (documentId !== null && !isDocumentId(documentId)) return null;
  // A submission row exists for every student of an open mentorship (null only
  // if the functions disagree, which is no answer); a submission needs a work.
  if (typeof row.submitted !== "boolean") return null;
  if (row.submitted && documentId === null) return null;
  const workState: MentoredWorkState = row.submitted
    ? "submitted"
    : documentId === null
      ? "not_started"
      : "in_progress";
  return {
    mentorshipId,
    assignmentId,
    documentId,
    student,
    title,
    workType: workType as MentoredWorkType,
    workState,
  };
}

/** The rows as mentored works, or null when any row is malformed or repeats a mentorship. */
export function mentoredWorksOf(rows: readonly Row[]): MentoredWork[] | null {
  const works: MentoredWork[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const work = mentoredWorkOf(row);
    if (work === null || seen.has(work.mentorshipId)) return null;
    seen.add(work.mentorshipId);
    works.push(work);
  }
  return works;
}

export function createMentoredWorksReader(withActor: WithActor): MentoredWorksReader {
  async function query(token: string, mentorshipId: string | null): Promise<MentoredWorksOutcome> {
    let rows: Row[] | null;
    try {
      rows = await withActor(token, async (tx) => {
        // The read itself raises nothing when no mentorship matches, so an
        // ended or unknown session is asked for first, in the same transaction.
        const actor = (await tx.query<Row>(ACTOR_SQL)).rows[0];
        if (actor === undefined || actor.user_id === null || actor.institution_id === null) {
          return null;
        }
        return (await tx.query<Row>(SQL, [mentorshipId])).rows;
      });
    } catch (thrown) {
      if (codeOf(thrown) === "ZD401") return { status: "unauthenticated" };
      return { status: "unavailable", reason: "database_error" };
    }
    if (rows === null) return { status: "unauthenticated" };
    const works = mentoredWorksOf(rows);
    if (works === null) return { status: "unavailable", reason: "row_malformed" };
    return { status: "ok", works };
  }

  return {
    readMentoredWorks: (token) => query(token, null),
    async readMentoredWork(token, mentorshipId) {
      if (!UUID.test(mentorshipId)) return { status: "not_found" };
      const read = await query(token, mentorshipId);
      if (read.status !== "ok") return read;
      const [work] = read.works;
      if (work === undefined) return { status: "not_found" };
      return work.mentorshipId === mentorshipId && read.works.length === 1
        ? { status: "ok", work }
        : { status: "unavailable", reason: "row_malformed" };
    },
  };
}

import type { WithActor } from "../index.ts";

// SRV-1414: the two reads of the student's side of mentorship, each one RPC of
// the main database. The functions decide who may: ZD401 without a session,
// ZD403 for a caller with a confirmed teacher role, which the HTTP adapter maps.
// F4 wave 2 #3: a declined request also reads the teacher's reason through
// app.student_mentorship_decline_reason, which answers only the student of the
// request; the other states never ask it.
const REQUESTS_SQL = `SELECT request_id, teacher_id, given_name, family_name, work_type, state,
       requested_at, ended_at, mentorship_id,
       CASE WHEN state = 'declined' THEN app.student_mentorship_decline_reason(request_id) END
         AS decline_reason
  FROM app.student_mentorship_requests()`;
const CANDIDATES_SQL =
  "SELECT teacher_id, given_name, family_name FROM app.student_mentor_candidates()";

type Name = { readonly givenName: string; readonly familyName: string } | null;

export type StudentMentorshipRequestRow = {
  readonly requestId: string;
  readonly teacherId: string;
  readonly teacherName: Name;
  readonly workType: string;
  readonly state: string;
  readonly requestedAt: string;
  readonly endedAt: string | null;
  readonly mentorshipId: string | null;
  /** The teacher's reason, only for a declined request that has one. */
  readonly declineReason: string | null;
};

export type MentorCandidateRow = {
  readonly teacherId: string;
  readonly name: Name;
  readonly department: null;
};

const nameOf = (given: unknown, family: unknown): Name =>
  typeof given === "string" && typeof family === "string"
    ? { givenName: given, familyName: family }
    : null;
const instant = (value: unknown): string => (value as Date).toISOString();

export function createStudentMentorshipReader(withActor: WithActor) {
  return {
    /** The caller's own requests, newest first. */
    requests: (token: string) =>
      withActor(token, async (tx) => {
        const { rows } = await tx.query<Record<string, unknown>>(REQUESTS_SQL);
        return rows.map((row): StudentMentorshipRequestRow => ({
          requestId: row.request_id as string,
          teacherId: row.teacher_id as string,
          teacherName: nameOf(row.given_name, row.family_name),
          workType: row.work_type as string,
          state: row.state as string,
          requestedAt: instant(row.requested_at),
          endedAt: row.ended_at === null ? null : instant(row.ended_at),
          mentorshipId: (row.mentorship_id as string | null) ?? null,
          declineReason:
            row.state === "declined" && typeof row.decline_reason === "string"
              ? row.decline_reason
              : null,
        }));
      }),
    /** The teachers the caller may ask; no source holds a department yet. */
    candidates: (token: string) =>
      withActor(token, async (tx) => {
        const { rows } = await tx.query<Record<string, unknown>>(CANDIDATES_SQL);
        return rows.map((row): MentorCandidateRow => ({
          teacherId: row.teacher_id as string,
          name: nameOf(row.given_name, row.family_name),
          department: null,
        }));
      }),
  };
}

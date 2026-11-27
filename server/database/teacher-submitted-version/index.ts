// F4-NAS-R20-SRV (Ductus#2059): the database port of the course teacher's read
// of the submitted revision of a student's work. One withActor transaction over
// existing RPCs only (no migration):
//   1. app.teacher_work_get       the caller must be a reader of the work; it names
//                                 the assignment and the student, and no row is the
//                                 one not_found of C-23 (not yours, not there)
//   2. app.assignment_submissions the revision of the live (not withdrawn) submission
//                                 of that student; a revision other than the asked one,
//                                 or no submission, is not_found
//   3. collaboration.read_live_state the submitted text; it rechecks the role of the
//                                 caller on the work and writes the access-log row of
//                                 the surface submitted_text.
// ZD401 is unauthenticated, ZD403 not_found, anything else unavailable.
import type { WithActor } from "../index.ts";

export type SubmittedVersionOutcome =
  | {
      readonly status: "ok";
      readonly revision: number;
      readonly body: string;
      readonly hash: string;
    }
  | { readonly status: "unauthenticated" | "not_found" | "unavailable" };

export type TeacherSubmittedVersion = {
  get(token: string, documentId: string, revision: number): Promise<SubmittedVersionOutcome>;
};

const WORK_SQL =
  "SELECT assignment_id::text AS assignment_id, student_id::text AS student_id, state FROM app.teacher_work_get($1)";
const SUBMISSION_SQL =
  "SELECT submitted, revision::text AS revision FROM app.assignment_submissions($1::uuid) WHERE student_id = $2::uuid";
const TEXT_SQL = "SELECT outcome, content_hash, body FROM collaboration.read_live_state($1, NULL)";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;

const NOT_FOUND = { status: "not_found" } as const;
const UNAVAILABLE = { status: "unavailable" } as const;

function codeOf(thrown: unknown): unknown {
  try {
    return thrown && typeof thrown === "object" && "code" in thrown ? thrown.code : undefined;
  } catch {
    return undefined;
  }
}

export function createTeacherSubmittedVersion(withActor: WithActor): TeacherSubmittedVersion {
  return {
    async get(token, documentId, revision) {
      try {
        return await withActor(token, async (tx): Promise<SubmittedVersionOutcome> => {
          const works = (await tx.query<Record<string, unknown>>(WORK_SQL, [documentId])).rows;
          if (works.length === 0) return NOT_FOUND;
          const work = works[0];
          if (
            works.length !== 1 ||
            typeof work?.assignment_id !== "string" ||
            !UUID.test(work.assignment_id) ||
            typeof work.student_id !== "string" ||
            !UUID.test(work.student_id)
          ) {
            return UNAVAILABLE;
          }
          if (work.state === "nije_predano") return NOT_FOUND;

          const submissions = (
            await tx.query<Record<string, unknown>>(SUBMISSION_SQL, [
              work.assignment_id,
              work.student_id,
            ])
          ).rows;
          if (submissions.length !== 1) return UNAVAILABLE;
          const submission = submissions[0]!;
          if (submission.submitted !== true || submission.revision !== String(revision)) {
            return NOT_FOUND;
          }

          const texts = (await tx.query<Record<string, unknown>>(TEXT_SQL, [documentId])).rows;
          if (texts.length !== 1) return UNAVAILABLE;
          const text = texts[0]!;
          // Any outcome but a submitted one is a live text, which is not the submission.
          if (text.outcome !== "submitted") {
            return text.outcome === "unavailable" ? UNAVAILABLE : NOT_FOUND;
          }
          if (
            typeof text.body !== "string" ||
            typeof text.content_hash !== "string" ||
            !HASH.test(text.content_hash)
          ) {
            return UNAVAILABLE;
          }
          return { status: "ok", revision, body: text.body, hash: text.content_hash };
        });
      } catch (thrown) {
        const code = codeOf(thrown);
        if (code === "ZD401") return { status: "unauthenticated" };
        if (code === "ZD403") return NOT_FOUND;
        return UNAVAILABLE;
      }
    },
  };
}

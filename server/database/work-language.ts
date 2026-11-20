// The port of the work language RPCs (contracts institution.work-language.post,
// institution.student-work-language.post, institution.work-work-language.post).
// Port of the write part of Ductus src/server/institution/work-language.ts
// (setAssignmentWorkLanguage, setWorkLanguage, setWorkLanguageForDocument and
// refusalOf) at 078c780, in the form of institution-courses.ts: an outcome
// (status) instead of a kind, a malformed row rolls back and is unavailable,
// the port never throws, and no SQLSTATE or message leaves it (Ductus logged
// the code; here it is the reason database_error). The database decides who
// may and when (a teacher or mentor of the work, nothing after a submission
// request); a stale version and a work asked to be submitted are both ZD409.
import { parseWorkLanguage, type WorkLanguage } from "../domain/index.ts";

import { call, codeOf, single, type Refused, type Unavailable } from "./institution-courses.ts";
import type { WithActor } from "./with-actor.ts";

type Refusal = Refused<"unauthenticated" | "forbidden" | "conflict" | "invalid">;

export type AssignmentWorkLanguageOutcome =
  { readonly status: "updated"; readonly version: number } | Refusal | Unavailable;

/** The language the work has afterwards: its exception, or the assignment's with null. */
export type WorkLanguageOutcome =
  { readonly status: "updated"; readonly language: WorkLanguage } | Refusal | Unavailable;

export type WorkLanguages = {
  setAssignmentWorkLanguage(
    token: string,
    assignmentId: string,
    expectedVersion: number,
    language: WorkLanguage,
  ): Promise<AssignmentWorkLanguageOutcome>;
  setWorkLanguage(
    token: string,
    assignmentId: string,
    studentId: string,
    language: WorkLanguage | null,
  ): Promise<WorkLanguageOutcome>;
  /** The work named by its document id, so the student's id never reaches the browser. */
  setWorkLanguageForDocument(
    token: string,
    assignmentId: string,
    documentId: string,
    language: WorkLanguage | null,
  ): Promise<WorkLanguageOutcome>;
};

// Ductus work-language.ts UUID: version 1 to 8 and the RFC variant, any case.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ASSIGNMENT_SQL = "SELECT institution.set_assignment_work_language($1, $2, $3) AS version";
const WORK_SQL = "SELECT institution.set_work_language($1, $2, $3) AS language";
const WORKS_SQL =
  "SELECT x.student_id::text AS student_id FROM app.assignment_works($1::uuid) x WHERE x.document_id = $2 LIMIT 2";
const REFUSED = new Map<string, "unauthenticated" | "forbidden" | "conflict" | "invalid">([
  ["ZD401", "unauthenticated"],
  ["ZD403", "forbidden"],
  ["ZD409", "conflict"],
  ["ZD422", "invalid"],
] as const);
const FORBIDDEN = { status: "forbidden" } as const;
const INVALID = { status: "invalid" } as const;
// A document id that is no work of the caller's assignment, and a row of the
// wrong form; both thrown inside fn so withActor rolls back, known by identity.
const NO_WORK: unique symbol = Symbol("work-language no work");
const MALFORMED: unique symbol = Symbol("work-language malformed row");

const readLanguage = (rows: unknown) => parseWorkLanguage(single(rows, "language"));

export function createWorkLanguages(withActor: WithActor): WorkLanguages {
  return {
    async setAssignmentWorkLanguage(token, assignmentId, expectedVersion, language) {
      if (!UUID.test(assignmentId)) return FORBIDDEN;
      if (
        !Number.isSafeInteger(expectedVersion) ||
        expectedVersion < 1 ||
        parseWorkLanguage(language) === null
      ) {
        return INVALID;
      }
      const readVersion = (rows: unknown) => {
        const value = single(rows, "version");
        return typeof value === "number" && Number.isSafeInteger(value) && value >= expectedVersion
          ? value
          : null;
      };
      const params = [assignmentId, expectedVersion, language];
      const outcome = await call(
        withActor,
        token,
        ASSIGNMENT_SQL,
        params,
        readVersion,
        REFUSED,
        "assignment_language_malformed",
      );
      return "value" in outcome ? { status: "updated", version: outcome.value } : outcome;
    },
    async setWorkLanguage(token, assignmentId, studentId, language) {
      if (!UUID.test(assignmentId) || !UUID.test(studentId)) return FORBIDDEN;
      if (language !== null && parseWorkLanguage(language) === null) return INVALID;
      const params = [assignmentId, studentId, language];
      const outcome = await call(
        withActor,
        token,
        WORK_SQL,
        params,
        readLanguage,
        REFUSED,
        "work_language_malformed",
      );
      return "value" in outcome ? { status: "updated", language: outcome.value } : outcome;
    },
    async setWorkLanguageForDocument(token, assignmentId, documentId, language) {
      if (!UUID.test(assignmentId)) return FORBIDDEN;
      if (language !== null && parseWorkLanguage(language) === null) return INVALID;
      try {
        // One transaction: app.assignment_works() names the work's student for
        // a teacher of the assignment, then set_work_language() decides again.
        const after = await withActor(token, async (tx) => {
          const works = (await tx.query(WORKS_SQL, [assignmentId, documentId])).rows;
          if (works.length === 0) throw NO_WORK;
          // A document id names one work; anything else is not explained here.
          const studentId = single(works, "student_id");
          if (typeof studentId !== "string" || !UUID.test(studentId)) throw MALFORMED;
          const read = readLanguage(
            (await tx.query(WORK_SQL, [assignmentId, studentId, language])).rows,
          );
          if (read === null) throw MALFORMED;
          return read;
        });
        return { status: "updated", language: after };
      } catch (thrown) {
        if (thrown === NO_WORK) return FORBIDDEN;
        if (thrown === MALFORMED)
          return { status: "unavailable", reason: "work_language_malformed" };
        const code = codeOf(thrown);
        const status = typeof code === "string" ? REFUSED.get(code) : undefined;
        return status === undefined
          ? { status: "unavailable", reason: "database_error" }
          : { status };
      }
    },
  };
}

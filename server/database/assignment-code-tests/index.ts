import type { WithActor } from "../index.ts";

/**
 * SRV-V21-KOD-TESTOVI-RUTA: the code tests of an assignment, revisions only added
 * (institution.assignment_code_tests, SRV-V21-KOD-TESTOVI-DB). The database decides who may (a
 * teacher of the assignment's course writes, a teacher and a student of it read) and raises ZD401,
 * ZD403, ZD404 and ZD422; they are not caught here, the HTTP edge maps them. Nothing in this port
 * comes from the caller but the session token, the assignment and the fields of the revision.
 */

export type StoredCodeTest = { id: string; title: string; input: unknown; expected: unknown };
export type AssignmentCodeTestsRevision = {
  revisionNo: number;
  language: string;
  tests: StoredCodeTest[];
};

const NONE: AssignmentCodeTestsRevision = { revisionNo: 0, language: "javascript", tests: [] };

const revisionOf = (row: AssignmentCodeTestsRevision): AssignmentCodeTestsRevision => ({
  revisionNo: row.revisionNo,
  language: row.language,
  tests: row.tests,
});

export function createAssignmentCodeTests(withActor: WithActor) {
  return {
    /** The latest revision for a teacher or a student of the assignment: revision 0 and no tests while none is set. */
    read(token: string, assignmentId: string): Promise<AssignmentCodeTestsRevision> {
      return withActor(token, async (tx) => {
        const { rows } = await tx.query<AssignmentCodeTestsRevision>(
          `SELECT revision_no AS "revisionNo", language, tests FROM app.get_assignment_code_tests($1::uuid)`,
          [assignmentId],
        );
        if (rows.length > 1) throw new Error("invalid code tests read");
        const row = rows[0];
        return row === undefined ? { ...NONE, tests: [] } : revisionOf(row);
      });
    },
    /** Adds the next revision; the revision number is the database's. */
    publish(
      token: string,
      assignmentId: string,
      language: string,
      tests: readonly StoredCodeTest[],
    ): Promise<AssignmentCodeTestsRevision> {
      return withActor(token, async (tx) => {
        const { rows } = await tx.query<AssignmentCodeTestsRevision>(
          `SELECT revision_no AS "revisionNo", language, tests FROM app.set_assignment_code_tests($1::uuid, $2::text, $3::jsonb)`,
          [assignmentId, language, JSON.stringify(tests)],
        );
        const row = rows[0];
        if (
          rows.length !== 1 ||
          row === undefined ||
          !Number.isInteger(row.revisionNo) ||
          row.revisionNo < 1
        ) {
          throw new Error("invalid published code tests revision");
        }
        return revisionOf(row);
      });
    },
  };
}

export type AssignmentCodeTestsStore = ReturnType<typeof createAssignmentCodeTests>;

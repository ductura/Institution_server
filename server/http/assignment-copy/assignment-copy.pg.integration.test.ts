// SRV-1904 acceptance on the real RPC in PostgreSQL, through the port the
// route uses: (1) the copy has no submission and no student row; (2) a target
// course the caller does not teach is not_found (404); (3) the source
// assignment is unchanged. Every person, course and text is invented; the
// assignments are those of the shared pgTAP fixture.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { expect, it } from "vitest";

import { createTestDatabase } from "../../../test-support/database/index.ts";
import { createAssignmentCopy, type WithActor } from "../../database/index.ts";

const FIXTURES = new URL("../../../db/main/tests/fixtures/", import.meta.url);
const VESNA = "A".repeat(43); // teacher of K1
const MARKO = "B".repeat(43); // teacher of K2
const PETRA = "I".repeat(43); // teacher of K3, another institution
const Z1 = "00000000-0000-4000-8000-0000000000a1";
const K1 = "00000000-0000-4000-8000-0000000000c1";
const K2 = "00000000-0000-4000-8000-0000000000c2";
const K3 = "00000000-0000-4000-8000-0000000000c3";

const SOURCE_STATE = `SELECT a.course_id, a.current_version,
    (SELECT json_agg(v ORDER BY v.version_no) FROM institution.assignment_version v WHERE v.assignment_id = a.id) AS versions,
    (SELECT count(*) FROM institution.notice_acknowledgment n WHERE n.assignment_id = a.id) AS acknowledgments
  FROM institution.assignment a WHERE a.id = $1`;
const STUDENT_ROWS = `SELECT count(*)::int AS n FROM (
    SELECT assignment_id FROM institution.notice_acknowledgment
    UNION ALL SELECT assignment_id FROM institution.notice_read
    UNION ALL SELECT assignment_id FROM institution.deadline_extension
    UNION ALL SELECT assignment_id FROM institution.work_language_override
    UNION ALL SELECT assignment_id FROM evidence.project
    UNION ALL SELECT assignment_id FROM evidence.submission_request
    UNION ALL SELECT assignment_id FROM evidence.submission
  ) x WHERE assignment_id = $1`;

it("copies an assignment without student rows, refuses an untaught course and leaves the source as it was", async () => {
  const db = await createTestDatabase("main", { authority: true });
  try {
    await db.exec(readFileSync(new URL("institution.inc", FIXTURES), "utf8"));
    const withActor: WithActor = async (token, run) => {
      await db.query("SELECT set_config('app.session_token', $1, true)", [token]);
      await db.exec("SET LOCAL ROLE ductus_app");
      try {
        return await run({
          async query<Row>(sql: string, args?: readonly unknown[]) {
            const { rows } = await db.query<Row>(sql, [...(args ?? [])]);
            return { rows, rowCount: rows.length };
          },
        });
      } finally {
        await db.exec("RESET ROLE");
      }
    };
    const port = createAssignmentCopy(withActor);
    const before = (await db.query(SOURCE_STATE, [Z1])).rows;
    const input = { assignmentId: Z1, courseId: K1, opensAt: null, dueAt: null };

    // (2) a target course the caller does not teach, and a source they do not teach.
    for (const [token, courseId] of [
      [VESNA, K2],
      [VESNA, K3],
      [MARKO, K2],
      [PETRA, K3],
    ] as const) {
      expect(await port.copy(token, { ...input, courseId, requestKey: randomUUID() })).toEqual({
        status: "not_found",
      });
    }
    expect(await port.copy("Z".repeat(43), { ...input, requestKey: randomUUID() })).toEqual({
      status: "unauthorized",
    });

    // (1) the copy: a new assignment of K1 at version 1, without student rows.
    const requestKey = randomUUID();
    const made = await port.copy(VESNA, { ...input, requestKey });
    expect(made).toMatchObject({ status: "copied" });
    const id = made.status === "copied" ? made.id : "";
    expect(id).not.toBe(Z1);
    const { rows } = await db.query<{ courseId: string; currentVersion: number }>(
      'SELECT course_id AS "courseId", current_version AS "currentVersion" FROM institution.assignment WHERE id = $1',
      [id],
    );
    expect(rows).toEqual([{ courseId: K1, currentVersion: 1 }]);
    expect((await db.query<{ n: number }>(STUDENT_ROWS, [id])).rows).toEqual([{ n: 0 }]);
    // The same key answers the same copy.
    expect(await port.copy(VESNA, { ...input, requestKey })).toEqual({ status: "copied", id });

    // (3) the source is unchanged.
    expect((await db.query(SOURCE_STATE, [Z1])).rows).toEqual(before);
  } finally {
    await db.close();
  }
});

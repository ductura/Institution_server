// SRV-NF1-PREDANO (Ductus#2055 c.7145546227): the list of own submissions over a
// migrated main database under ductus_app. Ana's requested submission is ceka
// for her and gives null; Dora, in the same course, sees the same assignment as
// none, never Ana's state; a session without a student course gets an empty
// list. Binding a potvrdeno receipt is covered by
// server/institution/student-assignment-submissions-route.test.ts.
import { readFileSync } from "node:fs";

import { expect, it } from "vitest";

import { createTestDatabase } from "../../test-support/database/index.ts";
import { createMyAssignmentSubmissionsReader, type WithActor } from "../database/index.ts";
import { readStudentAssignmentSubmissions } from "../institution/index.ts";

const FIXTURES = new URL("../../db/main/tests/fixtures/", import.meta.url);
const institution = readFileSync(new URL("institution.inc", FIXTURES), "utf8");
const evidence = readFileSync(new URL("evidence-acceptance.inc", FIXTURES), "utf8").replace(
  /^\\ir institution\.inc\r?\n/mu,
  "",
);

it("lists each student's own submission state only, under ductus_app", async () => {
  const db = await createTestDatabase("main", { authority: true });
  try {
    await db.exec(institution);
    await db.exec(evidence);
    // Both fixture writes and reads use the rollback-only test transaction.
    const withActor: WithActor = async (token, run) => {
      await db.query("SELECT set_config('app.session_token', $1, true)", [token]);
      await db.exec("SET LOCAL ROLE ductus_app");
      try {
        return await run({
          async query<Row>(text: string, values?: readonly unknown[]) {
            const { rows } = await db.query<Row>(text, [...(values ?? [])]);
            return { rows, rowCount: rows.length };
          },
        });
      } finally {
        await db.exec("RESET ROLE");
      }
    };
    const reader = createMyAssignmentSubmissionsReader(withActor);
    const assignmentId = "00000000-0000-4000-8000-0000000000a1";
    const ana = "D".repeat(43);
    const dora = "E".repeat(43);
    const none = { assignmentId, stored: { state: "none" } };
    expect(await reader.read(ana)).toEqual({ ok: true, value: [none] });

    const record = await db.query<{ outcome: string }>(`SELECT
        pg_temp.call('ana', 'pkg-a', 'request-1', pg_temp.descriptor(), 0,
          repeat('a', 64), repeat('d', 64), repeat('b', 64)) AS outcome`);
    expect(record.rows[0]?.outcome).toBe("reserved");
    await db.exec(
      `SELECT pg_temp.ask('ana', 'SELECT outcome FROM app.request_submission(''doc-a'', 1)')`,
    );
    const submission = await db.query<{ outcome: string }>(`SELECT pg_temp.ask('ana', format(
        'SELECT outcome FROM app.record_submission(%L::uuid, %L)',
        (SELECT id::text FROM evidence.submission_request WHERE document_id = 'doc-a'), pg_temp.h('d')
      )) AS outcome`);
    expect(submission.rows[0]?.outcome).toBe("recorded");

    expect(await reader.read(ana)).toMatchObject({
      ok: true,
      value: [{ assignmentId, stored: { state: "ceka", revision: 1 } }],
    });
    expect(await readStudentAssignmentSubmissions(reader, ana)).toEqual({
      status: 200,
      body: { assignments: [{ assignmentId, submittedAt: null, afterDeadline: null }] },
    });
    // Negative: Ana's submission is not in Dora's list.
    expect(await reader.read(dora)).toEqual({ ok: true, value: [none] });
    expect(await reader.read("A".repeat(43))).toEqual({ ok: true, value: [] });
  } finally {
    await db.close();
  }
});

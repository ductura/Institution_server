import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { expect, it } from "vitest";

import { createTestDatabase } from "../../../test-support/database/index.ts";
import { createAssignmentSubmissionsReader, type WithActor } from "../index.ts";

import { createTeacherSubmissionReader } from "./index.ts";

const FIXTURES = new URL("../../../db/main/tests/fixtures/", import.meta.url);
const ASSIGNMENT = "00000000-0000-4000-8000-0000000000a1";
const OTHER_ASSIGNMENT = "00000000-0000-4000-8000-0000000000a2";
const STUDENT = "00000000-0000-4000-8000-000000000104";
const DOCUMENT = '{"nodes":[],"schemaVersion":2}';
const HASH = createHash("sha256").update(DOCUMENT).digest("hex");

it.each([false, true])("reads the recorded submission with extension=%s", async (extended) => {
  const db = await createTestDatabase("main", { authority: true });
  try {
    await db.exec(readFileSync(new URL("institution.inc", FIXTURES), "utf8"));
    await db.exec(
      readFileSync(new URL("evidence-acceptance.inc", FIXTURES), "utf8").replace(
        /^\\ir institution\.inc\r?\n/mu,
        "",
      ),
    );
    await db.exec(`
      SET LOCAL ROLE ductus_identity;
      INSERT INTO institution.assignment_version (
        assignment_id, version_no, title, instructions, work_type, opens_at, due_at,
        ai_policy, ai_purposes, evidence_profile, import_allowed, created_by
      ) VALUES (pg_temp.id('z1'), 3, 'Z1', 'Izmisljeni zadatak.', 'essay', now() - interval '2 days',
                clock_timestamp() - interval '1 minute', 'partially_allowed', '{proofreading}',
                'extended', true, pg_temp.id('vesna'));
      UPDATE institution.assignment SET current_version = 3 WHERE id = pg_temp.id('z1');
      INSERT INTO institution.notice_acknowledgment (assignment_id, version_no, student_id, institution_id)
      VALUES (pg_temp.id('z1'), 3, pg_temp.id('ana'), pg_temp.id('fak_a'));
      RESET ROLE;
    `);

    async function ask(actor: string, sql: string) {
      return (
        await db.query<{ value: string }>("SELECT pg_temp.ask($1, $2) AS value", [actor, sql])
      ).rows[0]?.value;
    }

    if (extended) {
      expect(
        await ask(
          "vesna",
          `SELECT earlier_submissions::text FROM institution.extend_assignment_deadline(
        {z1}, {ana}, clock_timestamp() + interval '1 day', 'justified')`,
        ),
      ).toBe("false");
    }
    const { rows } = await db.query<{ outcome: string }>(
      `SELECT pg_temp.call(
      'ana', 'pkg-a', 'demo-request', pg_temp.descriptor(), 0, repeat('a', 64), $1, repeat('b', 64)
    ) AS outcome`,
      [DOCUMENT],
    );
    expect(rows[0]?.outcome).toBe("reserved");
    expect(await ask("ana", "SELECT outcome FROM app.request_submission('doc-a', 1)")).toBe(
      "requested",
    );
    const submissionId = await ask(
      "ana",
      `SELECT submission_id::text FROM app.record_submission(
      (SELECT id FROM evidence.submission_request), '${HASH}')`,
    );
    expect(submissionId).toMatch(/^[0-9a-f-]{36}$/);

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
    const teacher = "A".repeat(43);
    const list = await createAssignmentSubmissionsReader(withActor)(teacher, [ASSIGNMENT]);
    expect(list.status).toBe("ok");
    if (list.status === "ok") {
      expect(list.submissions.get(ASSIGNMENT)).toContainEqual(
        expect.objectContaining({ studentId: STUDENT, revision: 1, afterDeadline: !extended }),
      );
    }

    const read = createTeacherSubmissionReader(withActor);
    expect(await read(teacher, ASSIGNMENT, STUDENT)).toEqual({
      status: "ok",
      body: { studentId: STUDENT, revision: 1, late: !extended, document: DOCUMENT },
    });
    expect(await read("B".repeat(43), ASSIGNMENT, STUDENT)).toEqual({ status: "not_found" });
    expect(await read(teacher, OTHER_ASSIGNMENT, STUDENT)).toEqual({ status: "not_found" });
  } finally {
    await db.close();
  }
});

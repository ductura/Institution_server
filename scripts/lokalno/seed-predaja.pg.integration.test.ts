import { readFileSync } from "node:fs";

import { expect, it } from "vitest";

import { createTestDatabase } from "../../test-support/database/index.ts";
import { seedStatements } from "./config.ts";

it("preserves the existing demo states and seeds one past-due assignment on rerun", async () => {
  const db = await createTestDatabase("main", { authority: true });
  try {
    const seed = seedStatements(
      readFileSync(new URL("../../db/main/local/seed.sql", import.meta.url), "utf8").replaceAll(
        "\r\n",
        "\n",
      ),
    );
    const lateAssignment = async () =>
      (
        await db.query(`
        SELECT a.id, v.due_at < clock_timestamp() AS late, EXISTS (
          SELECT 1 FROM institution.course_enrollment_code e
          WHERE e.course_id = c.id AND e.active
            AND e.code_hash = sha256(convert_to('HIDRO2026DEMO', 'UTF8'))
        ) AS code
        FROM institution.assignment a
        JOIN institution.assignment_version v ON v.assignment_id = a.id AND v.version_no = a.current_version
        JOIN institution.course c ON c.id = a.course_id
        WHERE c.name = 'Izmišljeni seminar iz urbane hidrologije'
          AND v.title = 'Kratki osvrt: gradski vrtovi'
      `)
      ).rows;

    await db.exec(seed);
    const first = await lateAssignment();
    expect(first).toEqual([{ id: expect.any(String), late: true, code: true }]);
    await db.exec(seed);
    expect(await lateAssignment()).toEqual(first);

    const states = await db.query(`
      SELECT u.oidc_subject AS subject,
        EXISTS (SELECT 1 FROM institution.course_member m WHERE m.user_id = u.id
                AND m.role = 'student' AND m.member_to IS NULL) AS enrolled,
        EXISTS (SELECT 1 FROM evidence.document d WHERE d.principal_id = u.id) AS "hasWork"
      FROM identity.user_account u
      WHERE u.oidc_issuer = 'http://localhost:8090'
        AND u.oidc_subject IN ('demo-student', 'demo-student-2')
      ORDER BY u.oidc_subject
    `);
    expect(states.rows).toEqual([
      { subject: "demo-student", enrolled: true, hasWork: true },
      { subject: "demo-student-2", enrolled: false, hasWork: false },
    ]);
  } finally {
    await db.close();
  }
});

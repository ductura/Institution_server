import { readFileSync } from "node:fs";

import { expect, it } from "vitest";

import { createTestDatabase } from "../../../test-support/database/index.ts";

import type { WithActor } from "../index.ts";
import { createCourseAggregateReader } from "./index.ts";

const fixtures = new URL("../../../db/main/tests/fixtures/", import.meta.url);
const institution = readFileSync(new URL("institution.inc", fixtures), "utf8");
const evidence = readFileSync(new URL("evidence-acceptance.inc", fixtures), "utf8").replace(
  /^\\ir institution\.inc\r?\n/mu,
  "",
);

it("uses the active course roster and work scopes in Postgres", async () => {
  const db = await createTestDatabase("main", { authority: true });
  try {
    await db.exec(institution);
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
    const read = createCourseAggregateReader(withActor);
    const result = await db.query<{ id: string }>("SELECT pg_temp.id('k1')::text AS id");
    const id = result.rows[0]!.id;
    const as = (actor: string) => read(actor.repeat(43), id);
    await expect(as("X")).resolves.toEqual({ status: "unauthenticated" });
    for (const actor of ["B", "C", "D", "I"]) {
      await expect(as(actor)).resolves.toEqual({ status: "not_found" });
    }
    await db.exec(`
      WITH extra AS (
        INSERT INTO identity.user_account
          (institution_id, oidc_issuer, oidc_subject, hr_edu_person_unique_id)
        SELECT pg_temp.id('fak_a'), 'https://issuer.test', 'demo-aggregate-' || n,
               'demo-aggregate-' || n || '@fak-a.example'
          FROM generate_series(1, 3) n
        RETURNING id, institution_id
      )
      INSERT INTO institution.course_member (course_id, institution_id, user_id, role)
      SELECT pg_temp.id('k1'), institution_id, id, 'student' FROM extra;

      UPDATE institution.course_member SET member_to = now()
       WHERE course_id = pg_temp.id('k1') AND user_id = pg_temp.id('dora');
    `);
    await expect(as("A")).resolves.toEqual({ status: "suppressed" });
    await db.exec(`
      INSERT INTO institution.course_member (course_id, institution_id, user_id, role)
      VALUES (pg_temp.id('k1'), pg_temp.id('fak_a'), pg_temp.id('dora'), 'student')
    `);
    await expect(as("A")).resolves.toEqual({
      status: "available",
      notStarted: 5,
      inProgress: 0,
      submitted: 0,
    });
    await db.exec(`
      SELECT pg_temp.ask('vesna', $$ SELECT institution.set_course_holder({k1}, {vesna}) $$);
      INSERT INTO ref VALUES
        ('aggregate_group', pg_temp.ask('vesna', $$ SELECT institution.create_seminar_group({k1}, 'Izmišljena grupa') $$));
      SELECT pg_temp.ask('vesna', $$ SELECT institution.assign_group_teacher({aggregate_group}, {marko}) $$);
      SELECT pg_temp.ask('vesna', $$ SELECT institution.assign_group_student({aggregate_group}, {ana}) $$);
    `);
    const groupRoster = await db.query<{ students: string }>(`
      SELECT pg_temp.ask('marko', $$ SELECT count(*) FROM app.teacher_course_students({k1}) $$) AS students
    `);
    expect(groupRoster.rows).toEqual([{ students: "1" }]);
    await expect(as("B")).resolves.toEqual({ status: "not_found" });
    await db.exec(evidence);
    // Four not started, one started. Publishing either count would expose the other.
    await expect(as("A")).resolves.toEqual({ status: "suppressed" });
  } finally {
    await db.close();
  }
});

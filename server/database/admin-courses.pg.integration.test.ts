// F4 wave 2 #9 (1.9): the administrator creates a course with its first groups
// under PostgreSQL RLS, through the port. The harness keeps one test
// transaction, so a refused call rolls back only its own statement; that the
// whole creation rolls back with it is withActor's one transaction
// (admin-courses.test.ts).
import { readFileSync } from "node:fs";

import { expect, it } from "vitest";

import { createTestDatabase, exclusive } from "../../test-support/database/index.ts";

import { createAdminCourses } from "./admin-courses.ts";
import type { WithActor } from "./with-actor.ts";

const FIXTURE = readFileSync(
  new URL("../../db/main/tests/fixtures/institution.inc", import.meta.url),
  "utf8",
);

it("the administrator creates a course with its groups; a replay with others is conflict", async () => {
  const db = await createTestDatabase("main", { authority: true });
  try {
    await db.exec(FIXTURE);
    const one = async (sql: string) => (await db.query<{ v: string }>(sql)).rows[0]!.v;
    const iva = await one("SELECT token AS v FROM tok WHERE name = 'iva'");
    const vesna = await one("SELECT id::text AS v FROM person WHERE name = 'vesna'");
    const withActor: WithActor = (token, run) =>
      exclusive(db, async () => {
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
      });
    const port = createAdminCourses(withActor);
    const course = {
      name: "Izmišljeni seminar s grupama",
      academicYear: "2026/2027",
      aiPolicy: "prohibited",
      holderId: vesna,
      groups: ["Grupa B", "Grupa A"],
    };

    const made = await port.createCourse(iva, course);
    expect(made).toMatchObject({
      status: "created",
      groups: [{ name: "Grupa B" }, { name: "Grupa A" }],
    });
    if (made.status !== "created") throw new Error("not created");
    const stored = await db.query<{ id: string; name: string }>(
      "SELECT id::text, name FROM institution.seminar_group WHERE course_id = $1 ORDER BY name",
      [made.id],
    );
    expect(stored.rows).toEqual([
      { id: made.groups[1]!.id, name: "Grupa A" },
      { id: made.groups[0]!.id, name: "Grupa B" },
    ]);

    // The same request again: the same course and the same groups.
    expect(await port.createCourse(iva, course)).toEqual(made);
    // The same course with other groups leaves the groups as they were.
    expect(await port.createCourse(iva, { ...course, groups: ["Grupa C"] })).toEqual({
      status: "conflict",
    });
    expect(
      (await db.query("SELECT 1 FROM institution.seminar_group WHERE course_id = $1", [made.id]))
        .rows,
    ).toHaveLength(2);

    // Without groups, as before: a course and no group.
    const bare = await port.createCourse(iva, {
      ...course,
      name: "Izmišljeni seminar bez grupa",
      groups: [],
    });
    expect(bare).toMatchObject({ status: "created", groups: [] });
  } finally {
    await db.close();
  }
});

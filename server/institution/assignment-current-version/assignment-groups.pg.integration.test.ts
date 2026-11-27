// F4 wave 2 #5 (1.8): the creation of an assignment with the course's groups
// under PostgreSQL RLS, through the port and the read of the current version.
// The harness keeps one test transaction, so a refused call rolls back only
// its own statement; that the whole creation rolls back with it is withActor's
// one transaction (server/database/institution-assignments.test.ts).
import { readFileSync } from "node:fs";

import { expect, it } from "vitest";

import { createTestDatabase, exclusive } from "../../../test-support/database/index.ts";
import { createInstitutionAssignments, type WithActor } from "../../database/index.ts";

import { readAssignmentCurrentVersion } from "./index.ts";

const FIXTURE = readFileSync(
  new URL("../../../db/main/tests/fixtures/institution.inc", import.meta.url),
  "utf8",
);
const K1 = "00000000-0000-4000-8000-0000000000c1";
const TEACHER = "A".repeat(43);
const GROUP_A = "5b6c7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d01";
const GROUP_B = "5b6c7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d02";
const FOREIGN = "5b6c7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d03";
const UNKNOWN = "5b6c7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d04";
const SETUP = { externalToolsAllowed: false, aiSummaryOnly: false };
const day = 24 * 60 * 60 * 1000;
const CONTENT = {
  title: "Izmišljeni zadatak po grupama",
  instructions: "Upute za izmišljeni zadatak.",
  workType: "essay",
  opensAt: new Date(Date.now() + day).toISOString(),
  dueAt: new Date(Date.now() + 8 * day).toISOString(),
  aiPolicy: "partially_allowed",
  aiPurposes: ["proofreading"],
  evidenceProfile: "extended",
  importAllowed: true,
  wordMin: null,
  wordMax: null,
};
const key = (n: number) => `6c7d8e9f-0a1b-4c2d-8e3f-4a5b6c7d8e${String(n).padStart(2, "0")}`;

it("stores the course's groups with the assignment and reads them back", async () => {
  const db = await createTestDatabase("main", { authority: true });
  try {
    await db.exec(FIXTURE);
    // Two groups of K1 (Vesna's) and one of K2 (Marko's).
    await db.query(
      `INSERT INTO institution.seminar_group (id, course_id, institution_id, name, created_by)
       SELECT g.id::uuid, c.id, c.institution_id, g.name, c.created_by
         FROM (VALUES ($1, 'k1', 'Grupa A'), ($2, 'k1', 'Grupa B'), ($3, 'k2', 'Grupa C'))
              AS g (id, course, name)
         JOIN institution.course c ON c.id = pg_temp.id(g.course)`,
      [GROUP_A, GROUP_B, FOREIGN],
    );
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
    const port = createInstitutionAssignments(withActor);
    const create = (n: number, groups: string[]) =>
      port.createAssignment(TEACHER, K1, key(n), CONTENT, false, SETUP, groups);
    const linksOf = async (id: string) =>
      (
        await db.query<{ group_id: string }>(
          "SELECT group_id::text FROM institution.assignment_group WHERE assignment_id = $1 ORDER BY 1",
          [id],
        )
      ).rows.map((row) => row.group_id);

    const created = await create(1, [GROUP_B, GROUP_A]);
    expect(created).toMatchObject({ status: "created" });
    const id = (created as { id: string }).id;
    expect(await linksOf(id)).toEqual([GROUP_A, GROUP_B]);
    expect(await readAssignmentCurrentVersion(withActor, TEACHER, id)).toMatchObject({
      kind: "found",
      body: { assignmentId: id, courseId: K1, groupIds: [GROUP_A, GROUP_B] },
    });

    // The same key with the same groups is the same assignment, linked once.
    expect(await create(1, [GROUP_A, GROUP_B])).toEqual({ status: "created", id });
    expect(await linksOf(id)).toEqual([GROUP_A, GROUP_B]);
    // The same key with fewer groups is the key's conflict; the links stay.
    expect(await create(1, [GROUP_A])).toEqual({ status: "conflict" });
    expect(await linksOf(id)).toEqual([GROUP_A, GROUP_B]);

    // A group of another course, or none at all, is invalid and links nothing.
    for (const [n, groups] of [
      [2, [GROUP_A, FOREIGN]],
      [3, [UNKNOWN]],
    ] as const) {
      expect(await create(n, [...groups])).toEqual({ status: "invalid" });
    }
    const { rows } = await db.query<{ links: number }>(
      "SELECT count(*)::int AS links FROM institution.assignment_group",
    );
    expect(rows).toEqual([{ links: 2 }]);

    // No groups is the whole course: no links, no groupIds in the read.
    const whole = await create(4, []);
    expect(whole).toMatchObject({ status: "created" });
    const wholeId = (whole as { id: string }).id;
    expect(await linksOf(wholeId)).toEqual([]);
    const read = await readAssignmentCurrentVersion(withActor, TEACHER, wholeId);
    expect(read).toMatchObject({ kind: "found" });
    expect((read as { body: Record<string, unknown> }).body).not.toHaveProperty("groupIds");
  } finally {
    await db.close();
  }
});

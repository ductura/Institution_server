import { readFileSync } from "node:fs";

import { expect, it } from "vitest";

import { createTestDatabase } from "../../test-support/database/index.ts";
import type { WithActor } from "../database/index.ts";

import { createDatabases } from "./databases.ts";
import { createLayers } from "./pipeline.ts";
import { startServer } from "./start.ts";
import { createTeacherRosterRoutesFor } from "./teacher-roster.ts";

const fixtures = new URL("../../db/main/tests/fixtures/", import.meta.url);
const institution = readFileSync(new URL("institution.inc", fixtures), "utf8");
const evidence = readFileSync(new URL("evidence-acceptance.inc", fixtures), "utf8").replace(
  /^\\ir institution\.inc\r?\n/mu,
  "",
);

it("serves group-scoped roster and submission data without opening a work", async () => {
  const db = await createTestDatabase("main", { authority: true });
  try {
    await db.exec(institution);
    await db.exec(`
      INSERT INTO ref VALUES
       ('group_a', pg_temp.ask('vesna', $$ SELECT institution.create_seminar_group({k1}, 'Grupa A') $$)),
       ('group_b', pg_temp.ask('vesna', $$ SELECT institution.create_seminar_group({k1}, 'Grupa B') $$));
      SELECT pg_temp.ask('vesna', $$ SELECT institution.set_course_holder({k1}, {vesna}) $$);
      SELECT pg_temp.ask('vesna', $$ SELECT institution.assign_group_teacher({group_b}, {marko}) $$);
      SELECT pg_temp.ask('vesna', $$ SELECT institution.assign_group_student({group_a}, {dora}) $$);
      SELECT pg_temp.ask('vesna', $$ SELECT institution.assign_group_student({group_b}, {ana}) $$);
    `);
    await db.exec(evidence);
    await db.exec(`
      CREATE TEMP TABLE roster_due AS
      SELECT due_at FROM institution.assignment_version
      WHERE assignment_id = pg_temp.id('z1') AND version_no = 2;
      GRANT SELECT ON roster_due TO ductus_evidence;
      SET LOCAL ROLE ductus_evidence;
      INSERT INTO evidence.document_revision
        (document_id, institution_id, revision, base_revision, principal_id, content_hash)
      SELECT document_id, institution_id, 1, 0, principal_id, pg_temp.h('d')
        FROM evidence.document_revision WHERE document_id = 'doc-a' AND revision = 0;
      WITH request AS (
        INSERT INTO evidence.submission_request (
          institution_id, assignment_id, assignment_version, project_id, document_id,
          principal_id, revision, content_hash, requested_at
        )
        SELECT r.institution_id, pg_temp.id('z1'), 2, 'project-a', r.document_id,
               r.principal_id, r.revision, r.content_hash, v.due_at + interval '30 seconds'
          FROM evidence.document_revision r
          CROSS JOIN roster_due v
         WHERE r.document_id = 'doc-a' AND r.revision = 1
        RETURNING *
      )
      INSERT INTO evidence.submission (
        submission_request_id, institution_id, principal_id, assignment_id, assignment_version,
        revision, artifact_hash, requested_at, due_at, recorded_at
      )
      SELECT id, institution_id, principal_id, assignment_id, assignment_version, revision,
             content_hash, requested_at, requested_at - interval '30 seconds', requested_at
        FROM request;
      RESET ROLE;
    `);
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
    const { rows } = await db.query<{ name: string; val: string }>("SELECT name, val FROM ref");
    const ids = new Map(rows.map(({ name, val }) => [name, val]));
    const accessCount = () => db.query("SELECT count(*) FROM audit.access_log");
    const before = await accessCount();
    const server = await startServer({
      host: "127.0.0.1",
      port: 0,
      layers: createLayers({ expectedOrigin: "https://ductura.example.invalid" }),
      databases: createDatabases(),
      routes: createTeacherRosterRoutesFor({ withActor }),
    });
    try {
      const get = async (path: string, actor: string) => {
        const answer = await fetch(`http://127.0.0.1:${server.port}/api/v1/teacher/${path}`, {
          headers: { cookie: `__Host-ductus_session=${actor.repeat(43)}` },
        });
        expect(answer.status).toBe(200);
        return answer.json();
      };
      const roster = `courses/${ids.get("k1")}/students`;
      const overview = `assignments/${ids.get("z1")}/overview`;
      const ana = { studentId: ids.get("ana"), groupName: "Grupa B" };
      const dora = { studentId: ids.get("dora"), groupName: "Grupa A" };
      const late = { ...ana, submitted: true, afterDeadline: true, evidenceRecord: null };
      const anaRoster = expect.objectContaining({
        ...ana,
        assignments: [
          { assignmentId: ids.get("z1"), documentId: "doc-a", workState: "in_progress" },
        ],
      });
      expect(await get(roster, "A")).toEqual({
        students: [
          anaRoster,
          expect.objectContaining({
            ...dora,
            assignments: [
              { assignmentId: ids.get("z1"), documentId: null, workState: "not_started" },
            ],
          }),
        ],
      });
      expect(await get(roster, "B")).toEqual({ students: [anaRoster] });
      expect(await get(overview, "A")).toEqual({
        students: [
          expect.objectContaining(late),
          expect.objectContaining({ ...dora, submitted: false }),
        ],
      });
      expect(await get(overview, "B")).toEqual({ students: [expect.objectContaining(late)] });
      for (const path of [roster, overview]) {
        expect(await get(path, "D")).toEqual({ students: [] });
        expect(await get(path, "I")).toEqual({ students: [] });
        expect(
          await get(path.replace(ids.get(path === roster ? "k1" : "z1")!, ids.get("nobody")!), "A"),
        ).toEqual({ students: [] });
      }
      expect(await accessCount()).toEqual(before);
    } finally {
      await server.close();
    }
  } finally {
    await db.close();
  }
});

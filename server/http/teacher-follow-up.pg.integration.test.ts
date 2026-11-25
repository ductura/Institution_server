// SRV-NF4-POTVRDE-DORADE: teacher.assignment-follow-up.get against the real
// app.assignment_follow_up as ductus_app. Someone else's student is the same
// as a student that does not exist: absent from the list, never a refusal.
import { readFileSync } from "node:fs";

import { Value } from "@sinclair/typebox/value";
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

// Ana: read and two acknowledged versions, an older open request and a later
// responded one. Tomo (fak_b, z3): an open request no one in fak_a may see.
const FOLLOW_UP_DATA = `
  INSERT INTO institution.notice_read (institution_id, assignment_id, student_id, read_at)
  SELECT institution_id, id, pg_temp.id('ana'), timestamptz '2026-12-01 08:02:37+00'
    FROM institution.assignment WHERE id = pg_temp.id('z1');
  UPDATE institution.notice_acknowledgment
     SET acknowledged_at = timestamptz '2026-12-01 08:03:59.5+00'
   WHERE assignment_id = pg_temp.id('z1') AND student_id = pg_temp.id('ana') AND version_no = 2;
  CREATE SEQUENCE pg_temp.follow_seq START 9007199254740100;
  CREATE TEMP TABLE follow_req (name text PRIMARY KEY, id uuid NOT NULL);
  WITH r AS (
    INSERT INTO collaboration.revision_request
      (institution_id, assignment_id, owner_id, document_id, anchor, state, version, row_seq,
       created_by, created_at)
    SELECT a.institution_id, a.id, pg_temp.id(v.owner), v.doc,
           '{"nodeId":"0f0e0d0c-0b0a-4000-8000-000000000001","quote":"prvi odlomak","prefix":"","suffix":" teksta","startHint":0,"endHint":12}',
           v.state, 1, nextval('pg_temp.follow_seq'), pg_temp.id(v.teacher), v.opened::timestamptz
      FROM (VALUES
        ('older', 'ana', 'z1', 'doc-a', 'open', 'vesna', '2026-12-05 10:00:00+00'),
        ('later', 'ana', 'z1', 'doc-a', 'responded', 'vesna', '2026-12-06 09:00:00+00'),
        ('other', 'tomo', 'z3', 'doc-t', 'open', 'petra', '2026-12-07 09:00:00+00')
      ) AS v (name, owner, assignment, doc, state, teacher, opened)
      JOIN institution.assignment a ON a.id = pg_temp.id(v.assignment)
    RETURNING id, state, created_at
  )
  INSERT INTO follow_req
  SELECT CASE WHEN state = 'responded' THEN 'later' ELSE 'open-' || created_at::text END, id FROM r;
  INSERT INTO collaboration.revision_request_version
    (request_id, institution_id, version, instruction, requested_revision, opened_by, opened_at)
  SELECT q.id, q.institution_id, 1, 'Izmisljena uputa koja ne izlazi.', 0, q.created_by, q.created_at
    FROM collaboration.revision_request q JOIN follow_req f ON f.id = q.id;
  INSERT INTO collaboration.revision_response
    (request_id, institution_id, version, kind, explanation, response_revision, author_id, created_at)
  SELECT q.id, q.institution_id, 1, 'done', 'Dopunjeno.', 0, q.owner_id,
         timestamptz '2026-12-06 09:17:42+00'
    FROM collaboration.revision_request q JOIN follow_req f ON f.id = q.id AND f.name = 'later';
`;

it("serves the follow-up only within the overview's reach, someone else's as absent", async () => {
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
    await db.exec(FOLLOW_UP_DATA);
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
    const routes = createTeacherRosterRoutesFor({ withActor });
    const route = routes.find((r) => r.contract.id === "teacher.assignment-follow-up.get")!;
    const server = await startServer({
      host: "127.0.0.1",
      port: 0,
      layers: createLayers({ expectedOrigin: "https://ductura.example.invalid" }),
      databases: createDatabases(),
      routes,
    });
    try {
      const get = async (assignment: string, actor: string) => {
        const answer = await fetch(
          `http://127.0.0.1:${server.port}/api/v1/teacher/assignments/${assignment}/follow-up`,
          { headers: { cookie: `__Host-ductus_session=${actor.repeat(43)}` } },
        );
        expect(answer.status).toBe(200);
        const text = await answer.text();
        expect(text).not.toContain("Izmisljena uputa");
        expect(text).not.toContain("doc-a");
        const body: unknown = JSON.parse(text);
        expect(Value.Check(route.contract.responses[0]!.body!, body)).toBe(true);
        return body;
      };
      const z1 = ids.get("z1")!;
      const ana = {
        studentId: ids.get("ana"),
        noticeReadAt: "2026-12-01T08:02:00.000Z",
        noticeAcknowledgedAt: "2026-12-01T08:03:00.000Z",
        noticeVersionNo: 2,
        revisionState: "responded",
        revisionChangedAt: "2026-12-06T09:15:00.000Z",
        openRevisionCount: 1,
      };
      const dora = {
        studentId: ids.get("dora"),
        noticeReadAt: null,
        noticeAcknowledgedAt: expect.stringMatching(/:00\.000Z$/u),
        noticeVersionNo: 1,
        revisionState: null,
        revisionChangedAt: null,
        openRevisionCount: 0,
      };
      // Holder: the whole course, in the overview's order.
      const all = (await get(z1, "A")) as { students: { studentId: string }[] };
      expect(all).toEqual({ students: [ana, dora] });
      // Collaborator of group B: Ana only; Dora is not there, not refused.
      expect(await get(z1, "B")).toEqual({ students: [ana] });
      // Negative ownership: the student herself, a teacher of another faculty
      // with her own open request on z3, and an unknown assignment get the
      // same empty answer as an assignment with no students.
      expect(await get(z1, "D")).toEqual({ students: [] });
      expect(await get(z1, "I")).toEqual({ students: [] });
      expect(await get(ids.get("nobody")!, "A")).toEqual({ students: [] });
      // Petra's own z3 is not reachable from fak_a, and Tomo's request stays hers.
      expect(await get(ids.get("z3")!, "A")).toEqual({ students: [] });
      expect(await accessCount()).toEqual(before);
    } finally {
      await server.close();
    }
  } finally {
    await db.close();
  }
});

import { readFileSync } from "node:fs";

import { expect, it } from "vitest";

import { createTestDatabase } from "../../../test-support/database/index.ts";
import type { WithActor } from "../../database/index.ts";
import { createDatabases, createLayers, startServer } from "../index.ts";

import { createStudentWorkRoutesFor } from "./index.ts";

// SRV-1412 acceptance over the live database roles. Fixture (institution.inc):
// Ana (D) acknowledged both versions of Z1 in K1; Dora (E) only the first;
// Z2 is K2's (no student of fak-a's K1 is in it); Z3 is K3's in fak-b, where
// Tomo (J) is a student; Vesna (A) teaches K1. Only fak-a has an evidence domain.
const FIXTURES = new URL("../../../db/main/tests/fixtures/", import.meta.url);
const ORIGIN = "https://ductura.example.invalid";

it("starts a work once and lists only the student's own works", async () => {
  const db = await createTestDatabase("main", { authority: true });
  try {
    await db.exec(readFileSync(new URL("institution.inc", FIXTURES), "utf8"));
    await db.exec(`INSERT INTO evidence.domain (id, institution_id, region)
      VALUES ('00000000-0000-4000-8000-0000000014d1', pg_temp.id('fak_a'), 'eu-central-1')`);
    const ids = (
      await db.query<{ z1: string; z2: string; z3: string; k1: string }>(
        "SELECT pg_temp.id('z1')::text AS z1, pg_temp.id('z2')::text AS z2, pg_temp.id('z3')::text AS z3, pg_temp.id('k1')::text AS k1",
      )
    ).rows[0]!;

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
    const server = await startServer({
      host: "127.0.0.1",
      port: 0,
      databases: createDatabases(),
      layers: createLayers({ expectedOrigin: ORIGIN }),
      routes: createStudentWorkRoutesFor({ withActor }),
    });
    try {
      const cookie = (actor: string) => `__Host-ductus_session=${actor.repeat(43)}`;
      const start = async (assignment: string, actor: string) => {
        const response = await fetch(
          `http://127.0.0.1:${server.port}/api/v1/assignments/${assignment}/start`,
          {
            method: "POST",
            headers: { origin: ORIGIN, "sec-fetch-site": "same-origin", cookie: cookie(actor) },
          },
        );
        return {
          status: response.status,
          body: (await response.json()) as Record<string, unknown>,
        };
      };
      const works = async (actor: string) => {
        const response = await fetch(`http://127.0.0.1:${server.port}/api/v1/student/works`, {
          headers: { cookie: cookie(actor) },
        });
        return {
          status: response.status,
          body: (await response.json()) as Record<string, unknown>,
        };
      };

      // Nothing is made before the start.
      expect(await works("D")).toEqual({ status: 200, body: { works: [] } });

      // (1) Ana's start makes one work; a second start answers the same one.
      const first = await start(ids.z1, "D");
      expect(first.status).toBe(200);
      expect(first.body).toEqual({
        workId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
        rulesVersion: null,
        language: "hr",
      });
      expect(await start(ids.z1.toUpperCase(), "D")).toEqual(first);
      const made = await db.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM evidence.project WHERE assignment_id = $1::uuid",
        [ids.z1],
      );
      expect(made.rows[0]!.n).toBe("1");

      // (2) Another course's assignment, another institution's and an unknown one: the same 404.
      for (const assignment of [ids.z2, ids.z3, "00000000-0000-4000-8000-00000000dead"]) {
        expect((await start(assignment, "D")).status).toBe(404);
      }
      // The teacher of K1 has no work of their own to start.
      expect((await start(ids.z1, "A")).status).toBe(404);
      // Dora has not acknowledged the current notice: 409, and nothing is written.
      expect((await start(ids.z1, "E")).status).toBe(409);
      // Tomo's institution has no evidence domain.
      expect((await start(ids.z3, "J")).status).toBe(503);
      // Counted over the fixture's people only: the database may hold other tests' rows.
      const all = await db.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM evidence.project p JOIN person ON person.id = p.principal_id",
      );
      expect(all.rows[0]!.n).toBe("1");

      // (3) Ana's projection: her work only, and no field of a teacher.
      const own = await works("D");
      expect(own.status).toBe(200);
      expect(own.body).toEqual({
        works: [
          {
            workId: first.body.workId,
            assignmentId: ids.z1,
            assignmentTitle: "Z1",
            courseId: ids.k1,
            courseName: expect.any(String),
            academicYear: expect.stringMatching(/^\d{4}\/\d{4}$/u),
            dueAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u),
            state: "in_progress",
            revision: 0,
            submittedAt: null,
            language: "hr",
            // She confirmed the current (second) notice of Z1.
            noticeChangedSinceSeen: false,
          },
        ],
      });
      // F4 1.6: Vesna's third version of Z1 is newer than the newest Ana confirmed.
      await db.exec(`INSERT INTO institution.assignment_version (
          assignment_id, version_no, title, instructions, work_type, opens_at, due_at, ai_policy,
          ai_purposes, evidence_profile, import_allowed, created_by)
        SELECT assignment_id, 3, title, instructions, work_type, opens_at, due_at, ai_policy,
               ai_purposes, evidence_profile, import_allowed, created_by
          FROM institution.assignment_version
         WHERE assignment_id = pg_temp.id('z1') AND version_no = 2;
        UPDATE institution.assignment SET current_version = 3 WHERE id = pg_temp.id('z1')`);
      const changed = await works("D");
      expect(changed.status).toBe(200);
      expect((changed.body.works as Record<string, unknown>[])[0]).toMatchObject({
        assignmentId: ids.z1,
        noticeChangedSinceSeen: true,
      });
      // Dora and Tomo see none of it.
      expect(await works("E")).toEqual({ status: 200, body: { works: [] } });
      expect(await works("J")).toEqual({ status: 200, body: { works: [] } });
      // An expired session.
      expect((await works("X")).status).toBe(401);
      expect((await start(ids.z1, "X")).status).toBe(401);
    } finally {
      await server.close();
    }
  } finally {
    await db.close();
  }
});

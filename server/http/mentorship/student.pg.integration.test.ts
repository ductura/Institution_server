import { readFileSync } from "node:fs";

import { expect, it } from "vitest";

import { createTestDatabase } from "../../../test-support/database/index.ts";
import type { WithActor } from "../../database/index.ts";
import { createDatabases, createLayers, startServer } from "../index.ts";

import { createMentorshipStudentRoutesFor } from "./index.ts";

// SRV-1414 acceptance over the live database roles: a student reads only the
// own requests, the candidates are the confirmed teachers of the student's
// own institution only, and a teacher on either route is 403. Fixture tokens:
// A Vesna, B Marko (teachers of fak-a), D Ana, E Dora (students of fak-a),
// G Nina (unconfirmed teacher role), I Petra (teacher of fak-b), J Tomo
// (student of fak-b), X an expired session.
const FIXTURES = new URL("../../../db/main/tests/fixtures/", import.meta.url);

it("serves the student's side of mentorship only along the student's own relations", async () => {
  const db = await createTestDatabase("main", { authority: true });
  try {
    await db.exec(readFileSync(new URL("institution.inc", FIXTURES), "utf8"));
    await db.exec(`INSERT INTO identity.person_name (user_id, institution_id, given_name, family_name)
      VALUES (pg_temp.id('vesna'), pg_temp.id('fak_a'), 'Vesna', 'Izmišljena'),
             (pg_temp.id('petra'), pg_temp.id('fak_b'), 'Petra', 'Izmišljenić')`);
    const asked = await db.query<{ ana: string; tomo: string }>(`
      SELECT pg_temp.ask('ana', $$ SELECT institution.request_mentorship({vesna}, 'bachelor_thesis') $$) AS ana,
             pg_temp.ask('tomo', $$ SELECT institution.request_mentorship({petra}, 'master_thesis') $$) AS tomo`);
    const { ana, tomo } = asked.rows[0]!;
    expect(ana).toMatch(/^[0-9a-f-]{36}$/u);
    expect(tomo).toMatch(/^[0-9a-f-]{36}$/u);
    const ids = (
      await db.query<{ vesna: string; marko: string; petra: string }>(
        "SELECT pg_temp.id('vesna')::text AS vesna, pg_temp.id('marko')::text AS marko, pg_temp.id('petra')::text AS petra",
      )
    ).rows[0]!;

    // Every call of the test database runs in its own savepoint, so a refusal
    // leaves the fixture as it was.
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
      layers: createLayers({ expectedOrigin: "https://ductura.example.invalid" }),
      routes: createMentorshipStudentRoutesFor({ withActor }),
    });
    try {
      const get = async (path: string, actor: string) => {
        const response = await fetch(`http://127.0.0.1:${server.port}/api/v1/student/${path}`, {
          headers: { cookie: `__Host-ductus_session=${actor.repeat(43)}` },
        });
        return {
          status: response.status,
          body: (await response.json()) as Record<string, unknown>,
        };
      };

      // (1) Ana reads her request, Dora and Tomo do not; nobody's list has another's id.
      const own = await get("mentorship-requests", "D");
      expect(own.status).toBe(200);
      expect(own.body).toEqual({
        requests: [
          {
            requestId: ana,
            teacherId: ids.vesna,
            teacherName: { givenName: "Vesna", familyName: "Izmišljena" },
            workType: "bachelor_thesis",
            state: "requested",
            requestedAt: expect.stringMatching(/Z$/u),
            endedAt: null,
            mentorshipId: null,
          },
        ],
      });
      expect(await get("mentorship-requests", "E")).toEqual({
        status: 200,
        body: { requests: [] },
      });
      const other = await get("mentorship-requests", "J");
      expect(JSON.stringify(other.body)).not.toContain(ana);
      expect(other.body).toMatchObject({ requests: [{ requestId: tomo, state: "requested" }] });

      await db.query(
        "SELECT pg_temp.ask('ana', $$ SELECT institution.withdraw_mentorship_request({ana_rq}) $$)".replace(
          "{ana_rq}",
          `'${ana}'`,
        ),
      );
      expect((await get("mentorship-requests", "D")).body).toMatchObject({
        requests: [{ requestId: ana, state: "withdrawn", endedAt: expect.stringMatching(/Z$/u) }],
      });

      // (2) Candidates: the confirmed teachers of the own institution only.
      expect(await get("mentor-candidates", "D")).toEqual({
        status: 200,
        body: {
          candidates: [
            {
              teacherId: ids.vesna,
              name: { givenName: "Vesna", familyName: "Izmišljena" },
              department: null,
            },
            { teacherId: ids.marko, name: null, department: null },
          ],
        },
      });
      expect(await get("mentor-candidates", "J")).toEqual({
        status: 200,
        body: {
          candidates: [
            {
              teacherId: ids.petra,
              name: { givenName: "Petra", familyName: "Izmišljenić" },
              department: null,
            },
          ],
        },
      });
      expect(JSON.stringify((await get("mentor-candidates", "G")).body)).not.toContain(ids.petra);

      // (3) A teacher on either student route is 403; no session is 401.
      for (const path of ["mentorship-requests", "mentor-candidates"]) {
        for (const teacher of ["A", "B", "I"]) {
          expect((await get(path, teacher)).status).toBe(403);
        }
        expect((await get(path, "X")).status).toBe(401);
      }
    } finally {
      await server.close();
    }
  } finally {
    await db.close();
  }
});

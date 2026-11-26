// SRV-ULOGA-POTVRDA-OPOZIV: both teacher role routes over the live database
// roles (ductus_app with the caller's session token), through the real HTTP
// pipeline. Proves what the stand-in of index.integration.test.ts cannot: only
// an administrator of the caller's institution confirms or revokes, another
// institution's person, a missing one and the administrator themself are the
// same 404 on confirmation and revoked false on revocation, each change leaves
// exactly one audit.teacher_role_event row with the administrator from the
// session, and a repeated request answers the same and writes nothing more.
// Fixture: db/main/tests/fixtures/institution.inc (every person is invented).
import { readFileSync } from "node:fs";

import { expect, it } from "vitest";

import { createTestDatabase } from "../../../test-support/database/index.ts";
import type { WithActor } from "../../database/index.ts";
import { createDatabases, createLayers, startServer } from "../index.ts";

import { createTeacherRoleRoutes } from "./index.ts";

const FIXTURES = new URL("../../../db/main/tests/fixtures/", import.meta.url);
const ORIGIN = "https://ductura.example.invalid";
// Session tokens of institution.inc: one letter per person, by id.
const TOKEN = { vesna: "A", iva: "C", ana: "D", boris: "F", lea: "H" } as const;
const ID = (n: number) => `00000000-0000-4000-8000-0000000001${String(n).padStart(2, "0")}`;
const VESNA = ID(1);
const IVA = ID(3);
const DORA = ID(5);
const BORIS = ID(6);
const PETRA = ID(9);
const MISSING = "00000000-0000-4000-8000-00000000dead";

it("confirms and revokes a teacher role only for the institution's administrator, once", async () => {
  const db = await createTestDatabase("main", { authority: true });
  const server = await (async () => {
    for (const fixture of ["institution.inc"]) {
      await db.exec(readFileSync(new URL(fixture, FIXTURES), "utf8"));
    }
    // Boris (fak-a) brought the teacher right at his last login; Dora did not.
    await db.exec(`INSERT INTO identity.teacher_eligibility (user_id, institution_id)
      SELECT id, institution_id FROM person WHERE name IN ('boris', 'petra')`);
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
    return startServer({
      host: "127.0.0.1",
      port: 0,
      layers: createLayers({ expectedOrigin: ORIGIN }),
      databases: createDatabases(),
      routes: createTeacherRoleRoutes({ withActor, recordActivity: async () => undefined }),
    });
  })();
  const post = async (who: keyof typeof TOKEN | "expired", path: string, id: string) => {
    const token = who === "expired" ? "X" : TOKEN[who];
    const answer = await fetch(
      `http://127.0.0.1:${server.port}/api/v1/institution/teachers/${id}/${path}`,
      {
        method: "POST",
        headers: {
          cookie: `__Host-ductus_session=${token.repeat(43)}`,
          origin: ORIGIN,
          "sec-fetch-site": "same-origin",
          "content-type": "application/json",
        },
        body: "{}",
      },
    );
    const body = (await answer.json()) as Record<string, unknown>;
    return [answer.status, answer.status < 300 ? body : body.error];
  };
  const confirm = (who: keyof typeof TOKEN | "expired", id: string) =>
    post(who, "role-confirmation", id);
  const revoke = (who: keyof typeof TOKEN | "expired", id: string) =>
    post(who, "role-revocation", id);
  const events = async () =>
    (
      await db.query<{ row: string }>(
        `SELECT e.kind || ' ' || t.name || ' by ' || a.name AS row
         FROM audit.teacher_role_event e
         JOIN person t ON t.id = e.teacher_id JOIN person a ON a.id = e.actor_id
         WHERE e.teacher_id IN ($1, $2) ORDER BY e.occurred_at, e.kind`,
        [BORIS, PETRA],
      )
    ).rows.map((r) => r.row);
  const isTeacher = async (id: string) =>
    (
      await db.query<{ active: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM institution.institution_role WHERE user_id = $1
           AND role = 'teacher' AND confirmed_at IS NOT NULL AND revoked_at IS NULL) AS active`,
        [id],
      )
    ).rows[0]!.active;

  try {
    // Who may not: no session, a teacher, a student.
    expect(await confirm("expired", BORIS)).toEqual([401, "unauthorized"]);
    expect(await confirm("vesna", BORIS)).toEqual([403, "forbidden"]);
    expect(await confirm("ana", BORIS)).toEqual([403, "forbidden"]);
    expect(await revoke("expired", VESNA)).toEqual([401, "unauthorized"]);
    expect(await revoke("vesna", VESNA)).toEqual([403, "forbidden"]);
    expect(await revoke("ana", VESNA)).toEqual([403, "forbidden"]);

    // For an administrator every candidate that cannot be confirmed is one 404:
    // another institution's person with the right, a missing one, themself,
    // one whose last login gave no right; and another institution's admin.
    for (const id of [PETRA, MISSING, IVA, DORA]) {
      expect(await confirm("iva", id)).toEqual([404, "not_found"]);
    }
    expect(await confirm("lea", BORIS)).toEqual([404, "not_found"]);
    expect(await isTeacher(BORIS)).toBe(false);
    expect(await events()).toEqual([]);

    // Confirmed once; the same request again answers the same and writes nothing.
    expect(await confirm("iva", BORIS)).toEqual([200, { confirmed: true }]);
    expect(await confirm("iva", BORIS.toUpperCase())).toEqual([200, { confirmed: true }]);
    expect(await isTeacher(BORIS)).toBe(true);
    expect(await events()).toEqual(["confirmed boris by iva"]);

    // Revocation: another institution's admin and a missing person read as false.
    expect(await revoke("lea", BORIS)).toEqual([200, { revoked: false }]);
    expect(await revoke("iva", MISSING)).toEqual([200, { revoked: false }]);
    // Petra is a confirmed teacher of fak-b: Iva (fak-a) cannot end her role.
    expect(await revoke("iva", PETRA)).toEqual([200, { revoked: false }]);
    expect(await isTeacher(PETRA)).toBe(true);
    expect(await isTeacher(BORIS)).toBe(true);

    // Revoked once; again is false and writes nothing.
    expect(await revoke("iva", BORIS)).toEqual([200, { revoked: true }]);
    expect(await revoke("iva", BORIS)).toEqual([200, { revoked: false }]);
    expect(await isTeacher(BORIS)).toBe(false);
    expect(await events()).toEqual(["confirmed boris by iva", "revoked boris by iva"]);

    // A revoked teacher can be confirmed again: a new role row and its own audit row.
    expect(await confirm("iva", BORIS)).toEqual([200, { confirmed: true }]);
    expect(await isTeacher(BORIS)).toBe(true);
    expect((await events()).filter((row) => row.startsWith("confirmed"))).toHaveLength(2);

    // A teacher of the same institution still cannot revoke it.
    expect(await revoke("vesna", BORIS)).toEqual([403, "forbidden"]);
    expect(await isTeacher(BORIS)).toBe(true);
  } finally {
    await server.close();
    await db.close();
  }
});

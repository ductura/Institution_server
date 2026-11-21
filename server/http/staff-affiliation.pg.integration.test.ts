// SRV-1403 acceptance on real PostgreSQL: a login through the ten-argument
// open_session (as ductus_auth) decides the affiliation, and
// GET /api/v1/me/staff-affiliation answers each person with their own row or
// the closed code. Personas of db/main/tests/fixtures/institution.inc; every
// person and organisation is invented.
import { readFileSync } from "node:fs";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestDatabase } from "../../test-support/database/index.ts";
import type { WithActor } from "../database/index.ts";

import { createDatabases } from "./databases.ts";
import { createLayers } from "./pipeline.ts";
import { createStaffAffiliationRouteFor } from "./staff-affiliation.ts";
import { type Running, startServer } from "./start.ts";

const institution = readFileSync(
  new URL("../../db/main/tests/fixtures/institution.inc", import.meta.url),
  "utf8",
);

type Db = Awaited<ReturnType<typeof createTestDatabase>>;
let db: Db;
let running: Running;
let base: string;
const tokens = new Map<string, string>();

async function login(who: string, source: string | null, scope: string | null): Promise<void> {
  await db.query(
    `SELECT set_config('test.who', $1, true), set_config('test.source', coalesce($2, ''), true),
            set_config('test.scope', coalesce($3, ''), true)`,
    [who, source, scope],
  );
  await db.exec(`
    DO $$
    DECLARE v_org text;
    BEGIN
      SELECT faculty || '.example' INTO STRICT v_org FROM person WHERE name = current_setting('test.who');
      SET LOCAL ROLE ductus_auth;
      PERFORM identity.open_session('https://issuer.test', 'sub-' || current_setting('test.who'),
        current_setting('test.who') || '@' || v_org, v_org, sha256(convert_to(gen_random_uuid()::text, 'UTF8')),
        NULL, NULL, NULL, nullif(current_setting('test.source'), ''), nullif(current_setting('test.scope'), ''));
      RESET ROLE;
    END $$;
  `);
}

const get = async (who: string, headers: Record<string, string> = {}) => {
  const token = tokens.get(who);
  const response = await fetch(base, {
    headers:
      token === undefined ? headers : { cookie: `__Host-ductus_session=${token}`, ...headers },
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

beforeAll(async () => {
  db = await createTestDatabase("main", { authority: true });
  await db.exec(institution);
  await db.exec(`
    UPDATE identity.institution SET aai_home_org = 'fak-a.example' WHERE id = pg_temp.id('fak_a');
    UPDATE identity.institution SET aai_home_org = 'fak-b.example' WHERE id = pg_temp.id('fak_b');
    INSERT INTO identity.institution_issuer (institution_id, oidc_issuer) VALUES
      (pg_temp.id('fak_a'), 'https://issuer.test'), (pg_temp.id('fak_b'), 'https://issuer.test');
  `);
  const { rows } = await db.query<{ name: string; token: string }>("SELECT name, token FROM tok");
  for (const { name, token } of rows) if (token !== "") tokens.set(name, token);
  const withActor: WithActor = async (token, run) => {
    await db.query("SELECT set_config('app.session_token', $1, true)", [token ?? ""]);
    await db.exec("SET LOCAL ROLE ductus_app");
    try {
      return await run({
        async query<Row>(text: string, values?: readonly unknown[]) {
          const result = await db.query<Row>(text, [...(values ?? [])]);
          return { rows: result.rows, rowCount: result.rows.length };
        },
      });
    } finally {
      await db.exec("RESET ROLE");
    }
  };
  running = await startServer({
    host: "127.0.0.1",
    port: 0,
    databases: createDatabases(),
    layers: createLayers({ expectedOrigin: "https://ductura.example.invalid" }),
    routes: [createStaffAffiliationRouteFor({ withActor })],
  });
  base = `http://127.0.0.1:${running.port}/api/v1/me/staff-affiliation`;
});

afterAll(async () => {
  await running?.close();
  await db?.close();
});

describe("staff affiliation over a login", () => {
  it("acceptance 2: a token without an affiliation leaves the closed code and no teacher right", async () => {
    await login("ana", null, null);
    expect(await get("ana")).toEqual({
      status: 200,
      body: { confirmed: false, code: "staff_affiliation_missing" },
    });
    const { rows } = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM identity.teacher_eligibility WHERE user_id = pg_temp.id('ana')",
    );
    expect(rows[0]!.n).toBe(0);
  });

  it("a scoped affiliation of the own institution is read back by its person alone", async () => {
    await login("boris", "eduPersonScopedAffiliation", "fak-a.example");
    const boris = await get("boris");
    expect(boris.status).toBe(200);
    expect(boris.body).toMatchObject({ confirmed: true, source: "eduPersonScopedAffiliation" });
    expect(typeof boris.body.confirmedAt).toBe("string");
    // Acceptance 1: another person of the same institution reads nothing of it.
    expect((await get("dora")).body).toEqual({
      confirmed: false,
      code: "staff_affiliation_missing",
    });
  });

  it("acceptance 3: another institution's affiliation is refused", async () => {
    await login("dora", "eduPersonScopedAffiliation", "fak-b.example");
    expect((await get("dora")).body).toEqual({
      confirmed: false,
      code: "staff_affiliation_missing",
    });
    expect(
      await db.query<{ v: string }>(
        "SELECT pg_temp.ask('iva', $$ SELECT 'done' FROM institution.confirm_teacher_role({dora}) $$) AS v",
      ),
    ).toMatchObject({ rows: [{ v: "ZD403: forbidden" }] });
  });

  it("without a session the answer is 401, and a cross-site read is 403", async () => {
    expect((await get("nobody-signed-in")).status).toBe(401);
    expect((await get("boris", { "sec-fetch-site": "cross-site" })).status).toBe(403);
  });
});

// SRV-15 acceptance (Ductus#2028 c.7008147932; owner decision "A opcija",
// c.7016215710) over real PostgreSQL with RLS and the local seed
// (db/main/local/seed.sql, SRV-01), through the three mounted group routes,
// a ductus_app login and migration 20261119170000. In the seminar the holder
// demo-teacher reads groups A and B, demo-teacher-2 (a collaborator through
// group B) reads them and adds a group but adds no teacher, demo-admin adds a
// teacher, and demo-student gets 403. Teachers come by family name in
// Croatian collation (Džombić before Kranjčec). Every name is invented; the login and
// the sessions exist only while this file runs. The groups it adds stay, as
// the seed's rows do, so every check of a list is "contains".
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join } from "node:path";

import { Value } from "@sinclair/typebox/value";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { seedStatements } from "../../scripts/lokalno/index.ts";
import { ROUTES } from "../../server/contracts/index.ts";
import { createWithActor } from "../../server/database/index.ts";
import {
  createDatabases,
  createInstitutionGroupRoutesFor,
  createLayers,
  type Running,
  startServer,
} from "../../server/http/index.ts";

const ADMIN_URL =
  process.env.DATABASE_URL ?? "postgres://ductus:ductus-local-only@127.0.0.1:54329/ductus";
const APP_LOGIN = "it_institution_groups_app";
const ORIGIN = "https://ductura.example.invalid";
const ROOT = join(import.meta.dirname, "../..");
const SCHEMA = ROUTES.find((r) => r.id === "institution.course-groups.get")!.responses[0]!.body;
const SEMINAR = "Izmišljeni seminar iz ekologije grada";
const ACCOUNTS = ["demo-teacher", "demo-teacher-2", "demo-admin", "demo-student"] as const;
type Account = (typeof ACCOUNTS)[number];
const tokens = Object.fromEntries(
  ACCOUNTS.map((name) => [name, randomBytes(32).toString("base64url")]),
) as Record<Account, string>;
const password = randomBytes(24).toString("hex");
const admin = new pg.Pool({ connectionString: ADMIN_URL, max: 2 });
let app: pg.Pool;
let server: Running;
let course: string;
let teacher2: string;
let holder: string;

beforeAll(async () => {
  await admin.query(seedStatements(readFileSync(join(ROOT, "db/main/local/seed.sql"), "utf8")));
  for (const subject of ACCOUNTS) {
    await admin.query(
      `INSERT INTO identity.session (token_hash, user_id, institution_id, expires_at)
       SELECT sha256(convert_to($1, 'UTF8')), u.id, u.institution_id, now() + interval '1 hour'
         FROM identity.user_account u JOIN identity.institution i ON i.id = u.institution_id
        WHERE i.slug = 'demo-fakultet' AND u.hr_edu_person_unique_id = $2 || '@demo.ductus.test'`,
      [tokens[subject], subject],
    );
  }
  const ids = await admin.query<{ course: string; teacher: string; holder: string }>(
    `SELECT c.id::text AS course, u.id::text AS teacher, h.id::text AS holder
       FROM institution.course c
       JOIN identity.user_account u ON u.institution_id = c.institution_id
       JOIN identity.user_account h ON h.institution_id = c.institution_id
      WHERE c.name = $1 AND u.hr_edu_person_unique_id = 'demo-teacher-2@demo.ductus.test'
        AND h.hr_edu_person_unique_id = 'demo-teacher@demo.ductus.test'`,
    [SEMINAR],
  );
  course = ids.rows[0]!.course;
  teacher2 = ids.rows[0]!.teacher;
  holder = ids.rows[0]!.holder;
  await admin.query(`DROP ROLE IF EXISTS ${APP_LOGIN}`);
  const ddl = await admin.query<{ ddl: string }>(
    "SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L IN ROLE ductus_app', $1::text, $2::text) AS ddl",
    [APP_LOGIN, password],
  );
  await admin.query(ddl.rows[0]!.ddl);
  const url = new URL(ADMIN_URL);
  url.username = APP_LOGIN;
  url.password = password;
  app = new pg.Pool({ connectionString: url.href, max: 2 });
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    layers: createLayers({ expectedOrigin: ORIGIN }),
    databases: createDatabases(),
    routes: createInstitutionGroupRoutesFor({ withActor: createWithActor(app) }),
  });
});

afterAll(async () => {
  await server?.close();
  await app?.end();
  await admin.query(
    "DELETE FROM identity.session WHERE token_hash = ANY (SELECT sha256(convert_to(t, 'UTF8')) FROM unnest($1::text[]) t)",
    [Object.values(tokens)],
  );
  await admin.query(`DROP ROLE IF EXISTS ${APP_LOGIN}`);
  await admin.end();
});

function send(method: "GET" | "POST", path: string, who: Account, body?: unknown) {
  const text = body === undefined ? undefined : JSON.stringify(body);
  return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: server.port,
        method,
        path,
        headers: {
          cookie: `__Host-ductus_session=${tokens[who]}`,
          "sec-fetch-site": "same-origin",
          ...(text === undefined
            ? {}
            : {
                origin: ORIGIN,
                "content-type": "application/json",
                "content-length": String(Buffer.byteLength(text)),
              }),
        },
      },
      (res) => {
        let answer = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (answer += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(answer) }));
      },
    );
    req.on("error", reject);
    req.end(text);
  });
}
const groupsOf = (who: Account) => send("GET", `/api/v1/institution/courses/${course}/groups`, who);

describe("SRV-15: the seminar's groups from the seed", () => {
  it.each(["demo-teacher", "demo-teacher-2", "demo-admin"] as const)(
    "%s reads groups A and B in the contract's shape",
    async (who) => {
      const got = await groupsOf(who);
      expect(got.status).toBe(200);
      expect(Value.Check(SCHEMA as never, got.body)).toBe(true);
      const groups = got.body.groups as Record<string, unknown>[];
      expect(groups.filter((g) => g.name === "Grupa A" || g.name === "Grupa B")).toEqual([
        { id: expect.any(String), name: "Grupa A", teachers: [], students: 1 },
        {
          id: expect.any(String),
          name: "Grupa B",
          teachers: [{ id: teacher2, givenName: "Maja", familyName: "Džombić" }],
          students: 0,
        },
      ]);
    },
  );

  it("demo-student is 403 on the read and on a new group", async () => {
    expect((await groupsOf("demo-student")).status).toBe(403);
    const made = await send(
      "POST",
      `/api/v1/institution/courses/${course}/groups`,
      "demo-student",
      {
        name: "Grupa studenta",
      },
    );
    expect(made.status).toBe(403);
  });

  it("the collaborator adds a group but no teacher; the administrator adds one", async () => {
    const name = `Grupa ${randomUUID().slice(0, 8)}`;
    const made = await send(
      "POST",
      `/api/v1/institution/courses/${course}/groups`,
      "demo-teacher-2",
      {
        name,
      },
    );
    expect(made.status).toBe(200);
    const group = made.body.id as string;
    const teachers = `/api/v1/institution/groups/${group}/teachers`;
    const body = { teacherId: teacher2 };
    expect((await send("POST", teachers, "demo-teacher-2", body)).status).toBe(403);
    expect(await send("POST", teachers, "demo-admin", body)).toEqual({
      status: 200,
      body: { assigned: true },
    });
    expect(await send("POST", teachers, "demo-admin", body)).toEqual({
      status: 200,
      body: { assigned: false },
    });
    // By family name, whichever id is smaller: Džombić before Kranjčec (hr).
    expect(await send("POST", teachers, "demo-teacher", { teacherId: holder })).toEqual({
      status: 200,
      body: { assigned: true },
    });
    const listed = ((await groupsOf("demo-teacher")).body.groups as Record<string, unknown>[]).find(
      (g) => g.id === group,
    );
    expect(listed).toEqual({
      id: group,
      name,
      teachers: [
        { id: teacher2, givenName: "Maja", familyName: "Džombić" },
        { id: holder, givenName: "Petar", familyName: "Kranjčec" },
      ],
      students: 0,
    });
  });
});

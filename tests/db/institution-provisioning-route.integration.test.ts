import { createHash, randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createInstitutionProvisioning,
  createOpenSession,
  createWithActor,
} from "../../server/database/index.ts";
import {
  createDatabases,
  createInternalInstitutionRoutes,
  createLayers,
  createMeRoute,
  type Running,
  startServer,
} from "../../server/http/index.ts";
import { createMyAccountReader } from "../../server/database/index.ts";

// Contract Ductus#2028 c.6993786629 §2 and §3.3 on real PostgreSQL: POST and
// GET /internal/v1/institutions over identity.provision_institution and a
// ductus_auth login, every answer of §2, then a login of the new home
// organisation through open_session with no restart, and GET /api/v1/me over
// a ductus_app login. Every institution, person and token is random and
// synthetic; the logins exist only while this file runs.
const ADMIN_URL =
  process.env.DATABASE_URL ?? "postgres://ductus:ductus-local-only@127.0.0.1:54329/ductus";
const AUTH_LOGIN = "it_provisioning_auth";
const APP_LOGIN = "it_provisioning_app";
const ORIGIN = "https://ductura.example.invalid";
const TOKEN = randomBytes(32).toString("base64url");
const password = randomBytes(24).toString("hex");
const suffix = randomBytes(4).toString("hex");
const ISSUER = `http://idp-${suffix}.example.invalid:8090`;
const BODY = {
  slug: `it-prov-${suffix}`,
  displayName: "Fakultet za provjeru (test)",
  aaiHomeOrg: `prov-${suffix}.example`,
  oidcIssuer: ISSUER,
  seats: { student: 200, teacher: 50, network_engineer: 3, institution_admin: 1 },
};
const SESSION = randomBytes(32).toString("base64url");

const admin = new pg.Pool({ connectionString: ADMIN_URL, max: 1 });
const pools: pg.Pool[] = [];
let server: Running;
let auth: pg.Pool;

function loginPool(login: string): pg.Pool {
  const url = new URL(ADMIN_URL);
  url.username = login;
  url.password = password;
  const pool = new pg.Pool({ connectionString: url.href, max: 2 });
  pools.push(pool);
  return pool;
}

async function makeLogin(login: string, group: string): Promise<void> {
  await admin.query(`DROP ROLE IF EXISTS ${login}`);
  const ddl = await admin.query<{ ddl: string }>(
    "SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L IN ROLE %I', $1::text, $2::text, $3::text) AS ddl",
    [login, password, group],
  );
  await admin.query(ddl.rows[0]!.ddl);
}

beforeAll(async () => {
  await makeLogin(AUTH_LOGIN, "ductus_auth");
  await makeLogin(APP_LOGIN, "ductus_app");
  auth = loginPool(AUTH_LOGIN);
  const app = loginPool(APP_LOGIN);
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    layers: createLayers({ expectedOrigin: ORIGIN }),
    databases: createDatabases(),
    routes: [
      ...createInternalInstitutionRoutes({
        env: { DUCTURA_PROVISIONING_TOKEN: TOKEN },
        provisioning: createInstitutionProvisioning(auth),
      }),
      createMeRoute(createMyAccountReader(createWithActor(app))),
    ],
  });
});

afterAll(async () => {
  await server?.close();
  for (const pool of pools) await pool.end();
  try {
    const slugs = [BODY.slug, `${BODY.slug}-b`];
    const ids = (
      await admin.query<{ id: string }>(
        "SELECT id FROM identity.institution WHERE slug = ANY ($1)",
        [slugs],
      )
    ).rows.map((row) => row.id);
    for (const table of [
      "identity.session",
      "identity.person_name",
      "identity.user_account",
      "identity.institution_seat",
      "identity.institution_issuer",
      "institution.institution_settings",
    ]) {
      await admin.query(`DELETE FROM ${table} WHERE institution_id = ANY ($1)`, [ids]);
    }
    await admin.query("DELETE FROM identity.institution WHERE id = ANY ($1)", [ids]);
  } finally {
    await admin.query(`DROP ROLE IF EXISTS ${AUTH_LOGIN}`);
    await admin.query(`DROP ROLE IF EXISTS ${APP_LOGIN}`);
    await admin.end();
  }
});

type Answer = { status: number; body: string };
function send(method: string, path: string, headers: Record<string, string>, body?: string) {
  return new Promise<Answer>((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port: server.port, method, path, headers },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (text += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}
const bearer = { authorization: `Bearer ${TOKEN}` };
const provision = (body: unknown) =>
  send(
    "POST",
    "/internal/v1/institutions",
    { ...bearer, "content-type": "application/json" },
    JSON.stringify(body),
  );
const json = (answer: Answer) => JSON.parse(answer.body) as Record<string, unknown>;

describe("provisioning of an institution instance on PostgreSQL", () => {
  let institutionId: string;

  it("201 creates every row of the institution", async () => {
    const answer = await provision(BODY);
    expect(answer.status).toBe(201);
    const body = json(answer);
    expect(body).toMatchObject({ slug: BODY.slug, status: "aktivna" });
    institutionId = body.institutionId as string;
    const seats = await admin.query(
      "SELECT role, seats FROM identity.institution_seat WHERE institution_id = $1 ORDER BY role",
      [institutionId],
    );
    expect(
      Object.fromEntries(seats.rows.map((r: { role: string; seats: number }) => [r.role, r.seats])),
    ).toEqual(BODY.seats);
  });

  it("200 with the same id for the same data, also when sent at the same time", async () => {
    const answers = await Promise.all([provision(BODY), provision(BODY), provision(BODY)]);
    for (const answer of answers) {
      expect(answer.status).toBe(200);
      expect(json(answer)).toEqual({ institutionId, slug: BODY.slug, status: "aktivna" });
    }
  });

  it("409 slug_zauzet for other data on the slug, domena_zauzeta for a taken home organisation", async () => {
    let answer = await provision({ ...BODY, seats: { ...BODY.seats, student: 201 } });
    expect([answer.status, json(answer)]).toEqual([409, { greska: "slug_zauzet" }]);
    answer = await provision({ ...BODY, slug: `${BODY.slug}-b` });
    expect([answer.status, json(answer)]).toEqual([409, { greska: "domena_zauzeta" }]);
    const left = await admin.query("SELECT 1 FROM identity.institution WHERE slug = $1", [
      `${BODY.slug}-b`,
    ]);
    expect(left.rowCount).toBe(0);
  });

  it("400 for a display name the database refuses (is_plain_label), with nothing written", async () => {
    const answer = await provision({
      ...BODY,
      slug: `${BODY.slug}-b`,
      aaiHomeOrg: `b-${BODY.aaiHomeOrg}`,
      displayName: "a‮b",
    });
    expect([answer.status, json(answer)]).toEqual([
      400,
      { greska: "neispravan_unos", polje: "displayName" },
    ]);
  });

  it("GET returns the instance, 404 for an unknown slug, 401 without the token", async () => {
    let answer = await send("GET", `/internal/v1/institutions/${BODY.slug}`, bearer);
    expect([answer.status, json(answer)]).toEqual([
      200,
      { institutionId, ...BODY, status: "aktivna" },
    ]);
    answer = await send("GET", `/internal/v1/institutions/${BODY.slug}-nema`, bearer);
    expect(answer.status).toBe(404);
    answer = await send("GET", `/internal/v1/institutions/${BODY.slug}`, {});
    expect(answer.status).toBe(401);
  });

  it("an account of the new home organisation signs in at once and reads itself on /api/v1/me", async () => {
    const opened = await createOpenSession(auth)({
      issuer: ISSUER,
      subject: `sub-${suffix}`,
      uniqueId: `ana@${BODY.aaiHomeOrg}`,
      homeOrg: BODY.aaiHomeOrg,
      givenName: "Ana",
      familyName: "Primjer",
      teacherEligible: false,
      tokenHash: createHash("sha256").update(SESSION, "utf8").digest(),
    });
    expect(opened.ok).toBe(true);
    const answer = await send("GET", "/api/v1/me", { cookie: `__Host-ductus_session=${SESSION}` });
    expect([answer.status, json(answer)]).toEqual([
      200,
      {
        institution: { slug: BODY.slug, displayName: BODY.displayName },
        roles: ["student"],
        displayName: "Ana Primjer",
      },
    ]);
    const anonymous = await send("GET", "/api/v1/me", {
      cookie: `__Host-ductus_session=${randomBytes(32).toString("base64url")}`,
    });
    expect(anonymous.status).toBe(401);
  });

  it("the web process login cannot provision", async () => {
    await expect(
      createInstitutionProvisioning(pools[1]!).provision({ ...BODY, slug: `${BODY.slug}-b` }),
    ).rejects.toThrow();
  });
});

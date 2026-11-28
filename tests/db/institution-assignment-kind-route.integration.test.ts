// SRV-V13-VRSTA-PISAC (Ductus#2059; WEB#1146 / F4-V13-R04 found a slides
// assignment refused with 422): POST /api/v1/institution/courses/{courseId}/assignments
// with a kind, over real PostgreSQL with RLS, the local seed (db/main/local/seed.sql)
// and a ductus_app login, through the mounted assignment routes and the student's
// POST /api/v1/evidence/open. The kind the teacher sends is the kind stored
// (migration 20261220860000), read back through the row security and as the
// workKind of the student's work; a replay with another kind is 409, a version
// naming another kind 422, and a student of the course cannot create one. Every
// name and text is invented; the login and the sessions exist only while this
// file runs. The assignments it makes stay, as the seed's rows do.
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join } from "node:path";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { seedStatements } from "../../scripts/lokalno/index.ts";
import {
  createActorReader,
  createWithActor,
  createWorkOpener,
  type WithActor,
} from "../../server/database/index.ts";
import {
  createDatabases,
  createEvidenceOpenRoute,
  createInstitutionAssignmentRoutesFor,
  createLayers,
  type Running,
  startServer,
} from "../../server/http/index.ts";

const ADMIN_URL =
  process.env.DATABASE_URL ?? "postgres://ductus:ductus-local-only@127.0.0.1:54329/ductus";
const APP_LOGIN = "it_assignment_kind_app";
const ORIGIN = "https://ductura.example.invalid";
const ROOT = join(import.meta.dirname, "../..");
const SEMINAR = "Izmišljeni seminar iz ekologije grada";
const ACCOUNTS = ["demo-teacher", "demo-student"] as const;
type Account = (typeof ACCOUNTS)[number];
const tokens = Object.fromEntries(
  ACCOUNTS.map((name) => [name, randomBytes(32).toString("base64url")]),
) as Record<Account, string>;
const password = randomBytes(24).toString("hex");
const admin = new pg.Pool({ connectionString: ADMIN_URL, max: 2 });
let app: pg.Pool;
let withActor: WithActor;
let server: Running;
let course: string;
let student: string;

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
  const ids = await admin.query<{ course: string; student: string }>(
    `SELECT c.id::text AS course, u.id::text AS student
       FROM institution.course c
       JOIN identity.user_account u ON u.institution_id = c.institution_id
      WHERE c.name = $1 AND u.hr_edu_person_unique_id = 'demo-student@demo.ductus.test'`,
    [SEMINAR],
  );
  course = ids.rows[0]!.course;
  student = ids.rows[0]!.student;
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
  withActor = createWithActor(app);
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    layers: createLayers({ expectedOrigin: ORIGIN }),
    databases: createDatabases(),
    routes: [
      ...createInstitutionAssignmentRoutesFor({ withActor }),
      createEvidenceOpenRoute({
        actorReader: createActorReader(withActor),
        workOpener: createWorkOpener(withActor),
      }),
    ],
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

function post(path: string, who: Account, body: unknown, extra: Record<string, string> = {}) {
  const text = JSON.stringify(body);
  return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: server.port,
        method: "POST",
        path,
        headers: {
          cookie: `__Host-ductus_session=${tokens[who]}`,
          "sec-fetch-site": "same-origin",
          origin: ORIGIN,
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(text)),
          ...extra,
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

const CONTENT = {
  title: "Izmišljena prezentacija o gradskim vrtovima",
  instructions: "Izmišljene upute za izmišljeni zadatak.",
  workType: "seminar_paper",
  opensAt: new Date(Date.now() - 3_600_000).toISOString(),
  dueAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
  aiPolicy: "partially_allowed",
  aiPurposes: [] as string[],
  evidenceProfile: "basic",
  importAllowed: false,
  wordMin: null,
  wordMax: null,
};
const create = (who: Account, requestKey: string, kind: Record<string, unknown>) =>
  post(`/api/v1/institution/courses/${course}/assignments`, who, {
    requestKey,
    ...CONTENT,
    ...kind,
  });
/** The kind as the teacher reads it through ductus_app and the row security. */
const storedKind = (assignment: string) =>
  withActor(tokens["demo-teacher"], async (tx) => {
    const { rows } = await tx.query<{ document_kind: string }>(
      "SELECT document_kind FROM institution.assignment WHERE id = $1",
      [assignment],
    );
    return rows.map((row) => row.document_kind);
  });

describe("SRV-V13-VRSTA-PISAC: the kind of a new assignment over the real database", () => {
  it.each([
    ["documentKind slides", { documentKind: "slides" }, "slides"],
    ["workKind spreadsheet", { workKind: "spreadsheet" }, "spreadsheet"],
    ["workKind and documentKind slides", { workKind: "slides", documentKind: "slides" }, "slides"],
    ["no kind", {}, "text"],
  ])("%s is 201 and the kind read back is %s", async (_name, kind, stored) => {
    const made = await create("demo-teacher", randomUUID(), kind);
    expect(made.status).toBe(201);
    expect(await storedKind(made.body.id as string)).toEqual([stored]);
  });

  it("the student's work of a slides assignment opens as slides", async () => {
    const made = await create("demo-teacher", randomUUID(), { documentKind: "slides" });
    expect(made.status).toBe(201);
    const assignment = made.body.id as string;
    // The notice is confirmed as in the seed; the work opens only after it.
    await admin.query(
      `INSERT INTO institution.notice_acknowledgment (assignment_id, version_no, student_id, institution_id)
       SELECT a.id, 1, $2::uuid, a.institution_id FROM institution.assignment a WHERE a.id = $1`,
      [assignment, student],
    );
    const opened = await post(
      "/api/v1/evidence/open",
      "demo-student",
      { assignmentId: assignment, start: true },
      { "ductus-protocol": "1" },
    );
    expect(opened.status).toBe(200);
    expect(opened.body.workKind).toBe("slides");
  });

  it("a replay of the key with another kind is 409 and leaves the kind", async () => {
    const key = randomUUID();
    const made = await create("demo-teacher", key, { workKind: "slides" });
    expect(made.status).toBe(201);
    expect(await create("demo-teacher", key, { workKind: "slides" })).toEqual(made);
    expect((await create("demo-teacher", key, { workKind: "text" })).status).toBe(409);
    expect((await create("demo-teacher", key, {})).status).toBe(409);
    expect(await storedKind(made.body.id as string)).toEqual(["slides"]);
  });

  it("a version keeps the kind: another kind is 422, the same kind or none is 201", async () => {
    const made = await create("demo-teacher", randomUUID(), { workKind: "spreadsheet" });
    const versions = `/api/v1/institution/assignments/${made.body.id as string}/versions`;
    const version = (expectedVersion: number, kind: Record<string, unknown>) =>
      post(versions, "demo-teacher", { expectedVersion, ...CONTENT, ...kind });
    expect((await version(1, { documentKind: "text" })).status).toBe(422);
    expect((await version(1, { workKind: "slides" })).status).toBe(422);
    expect(await version(1, { workKind: "spreadsheet" })).toEqual({
      status: 201,
      body: { assignmentId: made.body.id, versionNo: 2 },
    });
    expect((await version(2, {})).status).toBe(201);
    expect(await storedKind(made.body.id as string)).toEqual(["spreadsheet"]);
  });

  it("a student of the course cannot create a slides assignment", async () => {
    const key = randomUUID();
    expect((await create("demo-student", key, { documentKind: "slides" })).status).toBe(403);
    const { rows } = await admin.query(
      "SELECT 1 FROM institution.assignment WHERE request_id = $1",
      [key],
    );
    expect(rows).toEqual([]);
  });
});

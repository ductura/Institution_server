import { createHash, randomBytes, randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { withActor, type WithActor } from "../../../server/database/index.ts";
import {
  createDatabases,
  createLayers,
  createStudentWriteRoutesFor,
  startServer,
  type Running,
} from "../../../server/http/index.ts";
import { SESSION_COOKIE_NAME } from "../../../server/session/index.ts";

import { expectHttpProblem } from "./http-problem.ts";

// Synthetic people and courses only; the app route uses the provisioned
// ductus_app_local login while fixture setup/cleanup uses the local admin.
const admin = new pg.Pool({
  connectionString:
    process.env.DATABASE_URL ?? "postgres://ductus:ductus-local-only@127.0.0.1:54329/ductus",
});
const institution = randomUUID();
const otherInstitution = randomUUID();
const token = () => randomBytes(32).toString("base64url");
const people = {
  teacher: { id: randomUUID(), institution, token: token() },
  member: { id: randomUUID(), institution, token: token() },
  guesser: { id: randomUUID(), institution, token: token() },
  removed: { id: randomUUID(), institution, token: token() },
  outsider: { id: randomUUID(), institution: otherInstitution, token: token() },
};
const peopleIds = Object.values(people).map((person) => person.id);
const origin = "http://localhost:3000";
let course = "";
let expiredCourse = "";
let code = "";
let expiredCode = "";
let server: Running;

function enrollmentServer(actor: WithActor, expectedOrigin: string | null = origin) {
  return startServer({
    host: "127.0.0.1",
    port: 0,
    layers: createLayers({ expectedOrigin }),
    databases: createDatabases(),
    routes: createStudentWriteRoutesFor({ withActor: actor }),
  });
}

function post(
  port: number,
  body: RequestInit["body"] = JSON.stringify({ code }),
  session = people.member.token,
  headers: Record<string, string> = {},
) {
  return fetch(`http://127.0.0.1:${port}/api/v1/student/enrollments`, {
    method: "POST",
    headers: {
      origin,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
      cookie: `${SESSION_COOKIE_NAME}=${session}`,
      ...headers,
    },
    body,
  });
}

async function reply(
  body: RequestInit["body"] = JSON.stringify({ code }),
  session = people.member.token,
  headers: Record<string, string> = {},
) {
  const response = await post(server.port, body, session, headers);
  expect(response.headers.get("cache-control")).toBe("no-store");
  return response;
}

async function count(table: "course_member" | "enrollment_attempt", personId: string) {
  const result = await admin.query(`SELECT count(*) FROM institution.${table} WHERE user_id = $1`, [
    personId,
  ]);
  return Number(result.rows[0].count);
}

beforeAll(async () => {
  const suffix = randomBytes(5).toString("hex");
  await admin.query("INSERT INTO identity.institution (id, slug) VALUES ($1, $2), ($3, $4)", [
    institution,
    `http-enroll-a-${suffix}`,
    otherInstitution,
    `http-enroll-b-${suffix}`,
  ]);
  await admin.query(
    `INSERT INTO institution.institution_settings (institution_id, display_name, enrollment_attempt_limit, enrollment_attempt_window)
     VALUES ($1, 'Test fakultet A', 5, '15 minutes'), ($2, 'Test fakultet B', 5, '15 minutes')`,
    [institution, otherInstitution],
  );
  for (const [name, person] of Object.entries(people)) {
    await admin.query(
      `INSERT INTO identity.user_account (id, institution_id, oidc_issuer, oidc_subject, hr_edu_person_unique_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        person.id,
        person.institution,
        `https://issuer-${suffix}.test`,
        `sub-${name}`,
        `${name}@http-enroll.example`,
      ],
    );
    await admin.query(
      `INSERT INTO identity.session (token_hash, user_id, institution_id, expires_at)
       VALUES ($1, $2, $3, now() + interval '1 hour')`,
      [createHash("sha256").update(person.token).digest(), person.id, person.institution],
    );
  }
  await admin.query(
    "INSERT INTO institution.institution_role (institution_id, user_id, role, confirmed_at) VALUES ($1, $2, 'teacher', now())",
    [institution, people.teacher.id],
  );
  const create = async (name: string) => {
    const result = await withActor(people.teacher.token, (tx) =>
      tx.query<{ id: string }>(
        "SELECT institution.create_course($1, '2026/2027', 'partially_allowed') AS id",
        [name],
      ),
    );
    return result.rows[0].id;
  };
  const issue = async (target: string) => {
    const result = await withActor(people.teacher.token, (tx) =>
      tx.query<{ code: string }>(
        "SELECT institution.create_enrollment_code($1, now() + interval '7 days') AS code",
        [target],
      ),
    );
    return result.rows[0].code;
  };
  course = await create("Izmišljeni kolegij A");
  expiredCourse = await create("Izmišljeni kolegij B");
  code = await issue(course);
  expiredCode = await issue(expiredCourse);
  await admin.query(
    "UPDATE institution.course_enrollment_code SET valid_until = now() - interval '1 day' WHERE course_id = $1",
    [expiredCourse],
  );
  await withActor(people.removed.token, (tx) =>
    tx.query("SELECT institution.enroll_with_code($1)", [code]),
  );
  await withActor(people.teacher.token, (tx) =>
    tx.query("SELECT institution.remove_student($1, $2)", [course, people.removed.id]),
  );
  server = await enrollmentServer(withActor);
});

afterAll(async () => {
  await server?.close();
  const institutions = [institution, otherInstitution];
  await admin.query("DELETE FROM institution.enrollment_attempt WHERE user_id = ANY($1)", [
    peopleIds,
  ]);
  // DAN-338: the removal's audit row is append-only; only this clean-up steps around the trigger.
  const cleaner = await admin.connect();
  try {
    await cleaner.query("BEGIN");
    await cleaner.query("SET LOCAL session_replication_role = replica");
    await cleaner.query("DELETE FROM audit.course_member_event WHERE institution_id = ANY($1)", [
      institutions,
    ]);
    await cleaner.query("COMMIT");
  } finally {
    cleaner.release();
  }
  await admin.query("DELETE FROM institution.course_member WHERE institution_id = ANY($1)", [
    institutions,
  ]);
  await admin.query("DELETE FROM institution.course_enrollment_code WHERE course_id = ANY($1)", [
    [course, expiredCourse],
  ]);
  await admin.query("DELETE FROM institution.course WHERE institution_id = ANY($1)", [
    institutions,
  ]);
  await admin.query("DELETE FROM institution.institution_role WHERE institution_id = ANY($1)", [
    institutions,
  ]);
  await admin.query("DELETE FROM institution.institution_settings WHERE institution_id = ANY($1)", [
    institutions,
  ]);
  await admin.query("DELETE FROM identity.session WHERE user_id = ANY($1)", [peopleIds]);
  await admin.query("DELETE FROM identity.user_account WHERE id = ANY($1)", [peopleIds]);
  await admin.query("DELETE FROM identity.institution WHERE id = ANY($1)", [institutions]);
  await admin.end();
});

describe("POST /api/v1/student/enrollments over real withActor and database", () => {
  it("rejects absent or invalid sessions, origins, and malformed bodies before a write", async () => {
    expect((await reply(undefined, "bad")).status).toBe(401);
    expect((await reply(undefined, token())).status).toBe(401);
    await admin.query(
      "UPDATE identity.session SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 minute' WHERE user_id = $1",
      [people.outsider.id],
    );
    expect((await reply(undefined, people.outsider.token)).status).toBe(401);
    await admin.query(
      "UPDATE identity.session SET expires_at = now() + interval '1 hour' WHERE user_id = $1",
      [people.outsider.id],
    );

    const deniedHeaders: Record<string, string>[] = [
      { origin: "" },
      { origin: "https://other.test", host: "localhost:3000" },
      { "sec-fetch-site": "cross-site", host: "localhost:3000" },
    ];
    for (const headers of deniedHeaders) {
      // An invalid JSON body would be 400 if reached before the origin check.
      expect((await reply("{", people.member.token, headers)).status).toBe(403);
    }
    expect((await reply("{", people.member.token)).status).toBe(400);
    expect((await reply(JSON.stringify({ code, userId: people.teacher.id }))).status).toBe(422);
    expect((await reply(JSON.stringify({ code: 42 }))).status).toBe(422);
    expect((await reply(JSON.stringify({ code: "A".repeat(65) }))).status).toBe(422);
    expect((await reply(new Uint8Array([0xff]).buffer)).status).toBe(400);
    expect((await reply("x".repeat(1025))).status).toBe(413);
    expect(
      (await reply(undefined, people.member.token, { "content-type": "text/plain" })).status,
    ).toBe(415);
    expect(await count("enrollment_attempt", people.member.id)).toBe(0);
    expect(await count("course_member", people.member.id)).toBe(0);

    const query = vi.fn().mockResolvedValue({
      rows: [{ outcome: "new_outcome", enrolled_course_id: null }],
      rowCount: 1,
    });
    const withUnknownOutcome: WithActor = (_token, run) => run({ query });
    const unconfigured = await enrollmentServer(withUnknownOutcome, null);
    try {
      expect((await post(unconfigured.port)).status).toBe(403);
      expect(query).not.toHaveBeenCalled();
    } finally {
      await unconfigured.close();
    }
    const unknown = await enrollmentServer(withUnknownOutcome);
    try {
      await expectHttpProblem(await post(unknown.port), 503, "unavailable");
      for (const [code, status, problem] of [
        ["ZD401", 401, "unauthorized"],
        ["ZD403", 403, "forbidden"],
      ] as const) {
        query.mockRejectedValueOnce({ code });
        await expectHttpProblem(await post(unknown.port), status, problem);
      }
    } finally {
      await unknown.close();
    }
  });

  it("normalizes a real code and leaves one membership after repeated HTTP calls", async () => {
    const normalized = code.toLowerCase().replaceAll("-", " - ");
    const enrolled = await reply(JSON.stringify({ code: normalized }));
    expect(enrolled.status).toBe(200);
    expect(await enrolled.json()).toEqual({ courseId: course, outcome: "enrolled_no_assignment" });
    const repeated = await reply();
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toEqual({ courseId: course, outcome: "already_enrolled" });
    expect(await count("course_member", people.member.id)).toBe(1);
    expect(await count("enrollment_attempt", people.member.id)).toBe(0);
  });

  it("counts invalid and expired codes and enforces the parallel rate limit across a fresh session", async () => {
    await expectHttpProblem(
      await reply(JSON.stringify({ code: "wrong-code" }), people.guesser.token),
      422,
      "invalid_code",
    );
    await expectHttpProblem(
      await reply(JSON.stringify({ code: expiredCode }), people.guesser.token),
      422,
      "expired_code",
    );
    await expectHttpProblem(await reply(undefined, people.outsider.token), 422, "invalid_code");
    await expectHttpProblem(await reply(undefined, people.removed.token), 422, "invalid_code");
    expect(await count("enrollment_attempt", people.guesser.id)).toBe(2);
    expect(await count("enrollment_attempt", people.outsider.id)).toBe(1);
    expect(await count("enrollment_attempt", people.removed.id)).toBe(1);
    expect(await count("course_member", people.outsider.id)).toBe(0);

    const answers = await Promise.all(
      Array.from({ length: 7 }, (_, i) =>
        reply(JSON.stringify({ code: `wrong-${i}` }), people.guesser.token),
      ),
    );
    expect(answers.filter((answer) => answer.status === 422)).toHaveLength(3);
    expect(answers.filter((answer) => answer.status === 429)).toHaveLength(4);
    expect(await count("enrollment_attempt", people.guesser.id)).toBe(5);
    const newSession = token();
    await admin.query(
      `INSERT INTO identity.session (token_hash, user_id, institution_id, expires_at)
       VALUES ($1, $2, $3, now() + interval '1 hour')`,
      [createHash("sha256").update(newSession).digest(), people.guesser.id, institution],
    );
    await expectHttpProblem(await reply(undefined, newSession), 429, "too_many_attempts");
    expect(await count("enrollment_attempt", people.guesser.id)).toBe(5);
    expect(await count("course_member", people.guesser.id)).toBe(0);
  });
});

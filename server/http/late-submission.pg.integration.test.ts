// SRV-NF4-KASNA-POLJE: both late submission routes on a real server over the
// real database (institution.set_late_submission_allowed,
// app.my_assignment_late_submission): the teacher of the assignment sets it
// and a student of its course reads the change; another teacher, a teacher of
// another faculty, a student and a student outside the course read 404 on
// both routes and change nothing (C-23). Only the fixtures of db/main/tests
// (invented people and assignments) are used.
import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTestDatabase, type TestDatabase } from "../../test-support/database/index.ts";
import { createLateSubmissionPort, type WithActor } from "../database/index.ts";

import { createDatabases } from "./databases.ts";
import { createLateSubmissionRoutes } from "./late-submission.ts";
import { createLayers } from "./pipeline.ts";
import { type Running, startServer } from "./start.ts";

const institution = readFileSync(
  new URL("../../db/main/tests/fixtures/institution.inc", import.meta.url),
  "utf8",
);
const ORIGIN = "https://ductura.example.invalid";
const Z1 = "00000000-0000-4000-8000-0000000000a1";
const Z3 = "00000000-0000-4000-8000-0000000000a3";

let db: TestDatabase;
let server: Running | undefined;
let base = "";

// Fixture writes and reads share the rollback-only test transaction.
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

beforeEach(async () => {
  db = await createTestDatabase("main", { authority: true });
  await db.exec(institution);
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    layers: createLayers({ expectedOrigin: ORIGIN }),
    databases: createDatabases(),
    routes: createLateSubmissionRoutes(createLateSubmissionPort(withActor)),
  });
  base = `http://127.0.0.1:${server.port}/api/v1`;
});
afterEach(async () => {
  await server?.close();
  server = undefined;
  await db.close();
});

async function cookieOf(person: string): Promise<string> {
  const { rows } = await db.query<{ token: string }>("SELECT token FROM tok WHERE name = $1", [
    person,
  ]);
  return `__Host-ductus_session=${rows[0]!.token}`;
}

async function put(person: string, assignment: string, allowed: boolean) {
  const res = await fetch(`${base}/institution/assignments/${assignment}/late-submission`, {
    method: "PUT",
    headers: {
      cookie: await cookieOf(person),
      origin: ORIGIN,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
    },
    body: JSON.stringify({ lateSubmissionAllowed: allowed }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function get(person: string, assignment: string) {
  const res = await fetch(`${base}/student/assignments/${assignment}/late-submission`, {
    headers: { cookie: await cookieOf(person) },
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function stored(assignment: string): Promise<boolean> {
  const { rows } = await db.query<{ allowed: boolean }>(
    `SELECT late_submission_allowed AS "allowed" FROM institution.assignment WHERE id = $1`,
    [assignment],
  );
  return rows[0]!.allowed;
}

describe("late submission over the real database", () => {
  it("allowed by default, the teacher forbids it and the students read it", async () => {
    expect(await get("ana", Z1)).toEqual({ status: 200, body: { lateSubmissionAllowed: true } });
    expect(await put("vesna", Z1, false)).toEqual({
      status: 200,
      body: { lateSubmissionAllowed: false },
    });
    expect(await stored(Z1)).toBe(false);
    expect(await get("ana", Z1)).toEqual({ status: 200, body: { lateSubmissionAllowed: false } });
    expect(await get("dora", Z1)).toEqual({ status: 200, body: { lateSubmissionAllowed: false } });
    expect(await put("vesna", Z1, true)).toEqual({
      status: 200,
      body: { lateSubmissionAllowed: true },
    });
    expect(await get("dora", Z1)).toEqual({ status: 200, body: { lateSubmissionAllowed: true } });
  });

  it.each(["marko", "petra", "iva", "ana", "nina"])(
    "%s cannot set Z1: 404, nothing changes",
    async (person) => {
      const got = await put(person, Z1, false);
      expect(got.status).toBe(404);
      expect(got.body.code).toBe("not_found");
      expect(await stored(Z1)).toBe(true);
    },
  );

  it("Vesna cannot set an assignment of another faculty", async () => {
    expect((await put("vesna", Z3, false)).status).toBe(404);
    expect(await stored(Z3)).toBe(true);
  });

  it.each([
    ["tomo", Z1],
    ["boris", Z1],
    ["vesna", Z1],
    ["ana", Z3],
  ])("%s does not read %s: 404", async (person, assignment) => {
    const got = await get(person, assignment);
    expect(got.status).toBe(404);
    expect(got.body.code).toBe("not_found");
  });

  it("an unknown assignment reads as another's", async () => {
    const unknown = "00000000-0000-4000-8000-0000000000ff";
    expect((await put("vesna", unknown, false)).status).toBe(404);
    expect((await get("ana", unknown)).status).toBe(404);
  });
});

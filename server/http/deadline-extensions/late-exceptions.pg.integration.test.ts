// SRV-NF4-IZNIMKA-ZAPIS: the three late-submission exception routes on a real
// server over the real database (institution.grant_late_submission_exception
// and the two readers): the teacher of the assignment records an exception for
// one student, lists it, and the student reads it marked as an exception; every
// other person, a teacher or student of another faculty and an unknown
// assignment read the same 404 and change nothing (C-23); bad input is 422 and
// writes nothing; the audit row is written with the record. Only the fixtures
// of db/main/tests (invented people and assignments) are used.
import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTestDatabase, type TestDatabase } from "../../../test-support/database/index.ts";
import type { WithActor } from "../../database/index.ts";
import { createDatabases, createLayers, type Running, startServer } from "../index.ts";

import { createDeadlineExtensionRoutesFor } from "./index.ts";

const institution = readFileSync(
  new URL("../../../db/main/tests/fixtures/institution.inc", import.meta.url),
  "utf8",
);
const ORIGIN = "https://ductura.example.invalid";
const Z1 = "00000000-0000-4000-8000-0000000000a1";
const Z3 = "00000000-0000-4000-8000-0000000000a3";
const NONE = "00000000-0000-4000-8000-00000000ffff";

type Body = {
  exception: { id: string; createdAt: string; reasonId: string | null };
  exceptions: { reasonId: string | null }[];
};

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
    routes: createDeadlineExtensionRoutesFor({ withActor }),
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

const inDays = (days: number): string => new Date(Date.now() + days * 86_400_000).toISOString();
async function studentId(person: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>("SELECT pg_temp.id($1) AS id", [person]);
  return rows[0]!.id;
}

async function grant(person: string, assignment: string, body: Record<string, unknown>) {
  const res = await fetch(`${base}/teacher/assignments/${assignment}/late-submission-exceptions`, {
    method: "POST",
    headers: {
      cookie: await cookieOf(person),
      origin: ORIGIN,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Body };
}

async function read(role: "teacher" | "student", person: string, assignment: string) {
  const res = await fetch(`${base}/${role}/assignments/${assignment}/late-submission-exceptions`, {
    headers: { cookie: await cookieOf(person) },
  });
  return { status: res.status, body: (await res.json()) as Body };
}

async function counts(): Promise<{ records: number; trail: number }> {
  const { rows } = await db.query<{ records: string; trail: string }>(
    `SELECT (SELECT count(*) FROM institution.late_submission_exception) AS records,
            (SELECT count(*) FROM audit.late_submission_exception_event) AS trail`,
  );
  return { records: Number(rows[0]!.records), trail: Number(rows[0]!.trail) };
}

describe("late-submission exceptions over the real database", () => {
  it("the teacher records one for Ana, lists it, Ana reads it marked, Dora reads nothing", async () => {
    const ana = await studentId("ana");
    const until = inDays(400);
    const made = await grant("vesna", Z1, {
      studentId: ana,
      untilAt: until,
      reasonId: "technical",
    });
    expect(made.status).toBe(201);
    expect(made.body.exception).toMatchObject({
      studentId: ana,
      untilAt: until,
      reasonId: "technical",
    });

    const listed = await read("teacher", "vesna", Z1);
    expect(listed).toMatchObject({ status: 200, body: { exceptions: [made.body.exception] } });

    const own = await read("student", "ana", Z1);
    expect(own.status).toBe(200);
    expect(own.body.exceptions).toEqual([
      {
        id: made.body.exception.id,
        kind: "exception",
        untilAt: until,
        reasonId: "technical",
        createdAt: made.body.exception.createdAt,
      },
    ]);
    expect(await read("student", "dora", Z1)).toEqual({ status: 200, body: { exceptions: [] } });
    // The record and its audit row are written by the same command.
    expect(await counts()).toEqual({ records: 1, trail: 1 });
  });

  it("a record is kept and a later one is added; it cannot shorten the earlier one", async () => {
    const ana = await studentId("ana");
    expect(
      (await grant("vesna", Z1, { studentId: ana, untilAt: inDays(400), reasonId: "justified" }))
        .status,
    ).toBe(201);
    expect(
      (await grant("vesna", Z1, { studentId: ana, untilAt: inDays(500), reasonId: "agreement" }))
        .status,
    ).toBe(201);
    expect(
      (await grant("vesna", Z1, { studentId: ana, untilAt: inDays(450), reasonId: "agreement" }))
        .status,
    ).toBe(422);
    const own = await read("student", "ana", Z1);
    expect(own.body.exceptions.map((e: { reasonId: string | null }) => e.reasonId)).toEqual([
      "justified",
      "agreement",
    ]);
    expect(await counts()).toEqual({ records: 2, trail: 2 });
  });

  it.each(["marko", "petra", "iva", "ana", "nina", "tomo"])(
    "%s cannot record or list on Z1: 404, nothing changes",
    async (person) => {
      const ana = await studentId("ana");
      const body = { studentId: ana, untilAt: inDays(400), reasonId: "justified" };
      expect((await grant(person, Z1, body)).status).toBe(404);
      expect((await read("teacher", person, Z1)).status).toBe(404);
      expect(await counts()).toEqual({ records: 0, trail: 0 });
    },
  );

  it.each(["vesna", "marko", "petra", "boris", "tomo"])(
    "%s is no student of Z1 and reads 404",
    async (person) => {
      expect((await read("student", person, Z1)).status).toBe(404);
    },
  );

  it("another faculty's assignment, an unknown assignment and a person who is no student are 404", async () => {
    const ana = await studentId("ana");
    const body = { studentId: ana, untilAt: inDays(400), reasonId: "justified" };
    expect((await grant("vesna", Z3, body)).status).toBe(404);
    expect((await grant("vesna", NONE, body)).status).toBe(404);
    expect((await read("teacher", "vesna", NONE)).status).toBe(404);
    expect((await read("student", "ana", Z3)).status).toBe(404);
    for (const who of ["tomo", "boris", "vesna"]) {
      const target = await studentId(who);
      expect((await grant("vesna", Z1, { ...body, studentId: target })).status).toBe(404);
    }
    expect(await counts()).toEqual({ records: 0, trail: 0 });
  });

  it("bad input is 422 and writes nothing", async () => {
    const ana = await studentId("ana");
    const ok = { studentId: ana, untilAt: inDays(400), reasonId: "justified" };
    for (const bad of [
      { ...ok, reasonId: "all" },
      { ...ok, reasonId: "drugo" },
      { ...ok, untilAt: inDays(-2) },
      { ...ok, untilAt: inDays(5) },
      { ...ok, untilAt: "2026-12-27" },
      { ...ok, note: "slobodan tekst" },
    ]) {
      expect((await grant("vesna", Z1, bad)).status).toBe(422);
    }
    expect(await counts()).toEqual({ records: 0, trail: 0 });
  });

  it("another teacher's reason is hidden from this teacher", async () => {
    await db.exec(`INSERT INTO institution.late_submission_exception
      (institution_id, assignment_id, student_id, until_at, reason_id, created_by)
      SELECT pg_temp.id('fak_a'), pg_temp.id('z1'), pg_temp.id('dora'), now() + interval '300 days', 'technical', pg_temp.id('marko')`);
    const listed = await read("teacher", "vesna", Z1);
    expect(listed.body.exceptions).toHaveLength(1);
    expect(listed.body.exceptions[0]?.reasonId).toBeNull();
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { ActorTransaction, WithActor } from "../../database/index.ts";
import { createDatabases, createLayers, startServer, type Running } from "../index.ts";

import { createStudentWorkRoutesFor } from "./index.ts";

// SRV-1412: the HTTP side of starting a work and reading the own works over a
// stand-in database. Who may is decided by the database and checked end to
// end in student-work.pg.integration.test.ts.
const ORIGIN = "https://ductura.example.invalid";
const STUDENT = "s".repeat(43);
const ASSIGNMENT = "00000000-0000-4000-8000-000000001412";
const WORK = "00000000-0000-4000-8000-0000000014c1";
const query = vi.fn<(token: string, sql: string, values: readonly unknown[]) => unknown[]>();
const withActor: WithActor = (token, run) =>
  run({
    query: async (sql: string, values?: readonly unknown[]) => {
      const rows = query(token!, sql, values ?? []);
      return { rows, rowCount: rows.length };
    },
  } as ActorTransaction);
const refusal = (code: string) =>
  Object.assign(new Error("refused"), { code }) as Error & { code: string };

/** A database row: camelCase keys here, snake_case columns as the driver gives them. */
const columns = (values: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`),
      value,
    ]),
  );

/** Answers of the three statements of a start, by the function each one calls. */
function startAnswers(open: unknown[], rules: unknown[], language: unknown[]) {
  // Any other statement (the session's activity mark) answers no row.
  query.mockImplementation((_token, sql) => {
    if (typeof sql !== "string") return [];
    if (sql.includes("open_student_work"))
      return open.map((r) => columns(r as Record<string, unknown>));
    if (sql.includes("assignment_institution_config")) return rules;
    if (sql.includes("work_language")) return language;
    return [];
  });
}

const workRow = (overrides: Record<string, unknown> = {}) =>
  columns({
    documentId: WORK,
    assignmentId: ASSIGNMENT,
    title: "Izmišljeni esej",
    courseId: "00000000-0000-4000-8000-0000000014f1",
    courseName: "Izmišljeni kolegij",
    academicYear: "2026/2027",
    dueAt: "2026-12-15T22:59:00.000Z",
    revision: "3",
    state: "none",
    requestedAt: null,
    language: "hr",
    ...overrides,
  });

let server: Running;
beforeAll(async () => {
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    databases: createDatabases(),
    layers: createLayers({ expectedOrigin: ORIGIN }),
    routes: createStudentWorkRoutesFor({ withActor }),
  });
});
afterAll(async () => server.close());
beforeEach(() => query.mockReset());

function start(id: string, token?: string, origin = ORIGIN) {
  const headers = new Headers({ origin, "sec-fetch-site": "same-origin" });
  if (token !== undefined) headers.set("cookie", `__Host-ductus_session=${token}`);
  return fetch(`http://127.0.0.1:${server.port}/api/v1/assignments/${id}/start`, {
    method: "POST",
    headers,
  });
}

function works(token?: string, site = "same-origin") {
  const headers = new Headers({ "sec-fetch-site": site });
  if (token !== undefined) headers.set("cookie", `__Host-ductus_session=${token}`);
  return fetch(`http://127.0.0.1:${server.port}/api/v1/student/works`, { headers });
}

describe("starting a work", () => {
  it("answers the work id, the rules version and the work language", async () => {
    startAnswers([{ outcome: "opened", documentId: WORK }], [{ version: 2 }], [{ language: "en" }]);
    const response = await start(ASSIGNMENT.toUpperCase(), STUDENT);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ workId: WORK, rulesVersion: 2, language: "en" });
    // The id reaches the database in lowercase, and the start always asks to make the work.
    const open = query.mock.calls.find(([, sql]) => String(sql).includes("open_student_work"))!;
    expect(open[2]).toEqual([ASSIGNMENT]);
    expect(open[1]).toContain("open_student_work($1::uuid, true)");
  });

  it("answers the same work on a second start (acceptance 1)", async () => {
    startAnswers([{ outcome: "opened", documentId: WORK }], [], [{ language: "hr" }]);
    const first = await (await start(ASSIGNMENT, STUDENT)).json();
    const second = await (await start(ASSIGNMENT, STUDENT)).json();
    expect(first).toEqual({ workId: WORK, rulesVersion: null, language: "hr" });
    expect(second).toEqual(first);
  });

  it("reads another course's assignment, an unknown and a malformed id as the same 404 (acceptance 2)", async () => {
    startAnswers([{ outcome: "not_found", documentId: null }], [], []);
    const other = await start(ASSIGNMENT, STUDENT);
    expect(other.status).toBe(404);
    expect(((await other.json()) as { code: string }).code).toBe("not_found");
    query.mockClear();
    const malformed = await start("nije-uuid", STUDENT);
    expect(malformed.status).toBe(404);
    expect(query.mock.calls.some(([, sql]) => String(sql).includes("open_student_work"))).toBe(
      false,
    );
  });

  it("maps a notice not yet acknowledged to 409 and a missing evidence domain to 503", async () => {
    startAnswers([{ outcome: "not_accepting", documentId: null }], [], []);
    expect((await start(ASSIGNMENT, STUDENT)).status).toBe(409);
    startAnswers([{ outcome: "not_configured", documentId: null }], [], []);
    expect((await start(ASSIGNMENT, STUDENT)).status).toBe(503);
  });

  it("refuses without a session, from another origin, and on a malformed row", async () => {
    expect((await start(ASSIGNMENT)).status).toBe(401);
    expect((await start(ASSIGNMENT, STUDENT, "https://drugo.example.invalid")).status).toBe(403);
    startAnswers([{ outcome: "opened", documentId: WORK }], [], [{ language: "de" }]);
    expect((await start(ASSIGNMENT, STUDENT)).status).toBe(503);
    startAnswers([{ outcome: "opened", documentId: WORK }], [{ version: 1 }, { version: 2 }], []);
    expect((await start(ASSIGNMENT, STUDENT)).status).toBe(503);
    query.mockImplementationOnce(() => {
      throw refusal("ZD401");
    });
    expect((await start(ASSIGNMENT, STUDENT)).status).toBe(401);
  });
});

describe("the student's works", () => {
  it("lists the own works by due time, with no field of a teacher (acceptance 3)", async () => {
    query.mockReturnValueOnce([
      workRow({
        documentId: "00000000-0000-4000-8000-0000000014c2",
        assignmentId: "00000000-0000-4000-8000-000000001413",
        dueAt: "2027-01-20T22:59:00.000Z",
        revision: "12",
        state: "ceka",
        requestedAt: "2027-01-19T10:15:00.000Z",
        language: "en",
      }),
      workRow(),
    ]);
    const response = await works(STUDENT);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { works: Record<string, unknown>[] };
    expect(body.works.map((w) => w.workId)).toEqual([WORK, "00000000-0000-4000-8000-0000000014c2"]);
    expect(body.works[1]).toMatchObject({
      state: "submitted",
      revision: 12,
      submittedAt: "2027-01-19T10:15:00.000Z",
    });
    for (const work of body.works) {
      expect(Object.keys(work).sort()).toEqual(
        [
          "academicYear",
          "assignmentId",
          "assignmentTitle",
          "courseId",
          "courseName",
          "dueAt",
          "language",
          "revision",
          "state",
          "submittedAt",
          "workId",
        ].sort(),
      );
    }
  });

  it("never passes a column the query does not name, a teacher's included", async () => {
    query.mockReturnValueOnce([workRow({ grade: "A", accommodation: true, teacherNote: "x" })]);
    const body = (await (await works(STUDENT)).json()) as { works: Record<string, unknown>[] };
    expect(body.works[0]).not.toHaveProperty("grade");
    expect(body.works[0]).not.toHaveProperty("accommodation");
    expect(body.works[0]).not.toHaveProperty("teacherNote");
  });

  it("answers an empty list, 401, 403 cross-site and 503 on a malformed or repeated row", async () => {
    query.mockReturnValueOnce([]);
    expect(await (await works(STUDENT)).json()).toEqual({ works: [] });
    expect((await works()).status).toBe(401);
    expect((await works(STUDENT, "cross-site")).status).toBe(403);
    query.mockReturnValueOnce([workRow({ state: "not_found" })]);
    expect((await works(STUDENT)).status).toBe(503);
    query.mockReturnValueOnce([workRow(), workRow()]);
    expect((await works(STUDENT)).status).toBe(503);
    query.mockImplementationOnce(() => {
      throw refusal("ZD401");
    });
    expect((await works(STUDENT)).status).toBe(401);
  });
});

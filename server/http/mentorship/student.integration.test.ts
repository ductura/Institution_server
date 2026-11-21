import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { ActorTransaction, WithActor } from "../../database/index.ts";
import { createDatabases, createLayers, startServer, type Running } from "../index.ts";

import { createMentorshipStudentRoutesFor } from "./index.ts";

// SRV-1414: the HTTP side of the student's mentorship reads over a stand-in
// database; who may read what is decided by the database (pgTAP 030) and
// checked end to end in student.pg.integration.test.ts.
const ORIGIN = "https://ductura.example.invalid";
const STUDENT = "s".repeat(43);
const TEACHER_ID = "00000000-0000-4000-8000-0000000014c1";
const REQUEST_ID = "00000000-0000-4000-8000-0000000014a1";
const query = vi.fn<(token: string, sql: string) => unknown[]>();
const withActor: WithActor = (token, run) =>
  run({
    query: async (sql: string) => {
      const rows = query(token!, sql);
      return { rows, rowCount: rows.length };
    },
  } as ActorTransaction);
// Database rows carry snake_case columns; these short keys name them.
const COLUMNS: Record<string, string> = {
  request: "request_id",
  teacher: "teacher_id",
  given: "given_name",
  family: "family_name",
  work: "work_type",
  requested: "requested_at",
  ended: "ended_at",
  mentorship: "mentorship_id",
};
const row = (values: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(values).map(([key, value]) => [COLUMNS[key] ?? key, value]));
const refusal = (code: string) =>
  Object.assign(new Error("refused"), { code }) as Error & { code: string };

let server: Running;
beforeAll(async () => {
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    databases: createDatabases(),
    layers: createLayers({ expectedOrigin: ORIGIN }),
    routes: createMentorshipStudentRoutesFor({ withActor }),
  });
});
afterAll(async () => server.close());
beforeEach(() => query.mockReset());

function get(path: string, token?: string, site = "same-origin") {
  const headers = new Headers({ "sec-fetch-site": site });
  if (token !== undefined) headers.set("cookie", `__Host-ductus_session=${token}`);
  return fetch(`http://127.0.0.1:${server.port}/api/v1/student/${path}`, { headers });
}

describe("the student's mentorship reads", () => {
  it("lists the own requests with the teacher's name and the instants", async () => {
    query.mockReturnValueOnce([
      row({
        request: REQUEST_ID,
        teacher: TEACHER_ID,
        given: "Vesna",
        family: "Izmišljena",
        work: "master_thesis",
        state: "declined",
        requested: new Date("2027-01-10T12:00:00.123456Z"),
        ended: new Date("2027-01-12T12:00:00Z"),
        mentorship: null,
      }),
    ]);
    const response = await get("mentorship-requests", STUDENT);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      requests: [
        {
          requestId: REQUEST_ID,
          teacherId: TEACHER_ID,
          teacherName: { givenName: "Vesna", familyName: "Izmišljena" },
          workType: "master_thesis",
          state: "declined",
          requestedAt: "2027-01-10T12:00:00.123Z",
          endedAt: "2027-01-12T12:00:00.000Z",
          mentorshipId: null,
        },
      ],
    });
    expect(query.mock.calls[0]![1]).toContain("app.student_mentorship_requests()");
  });

  it("lists the candidates with no personal datum beyond the name", async () => {
    query.mockReturnValueOnce([
      row({ teacher: TEACHER_ID, given: null, family: null, email: "x@y.invalid" }),
    ]);
    const response = await get("mentor-candidates", STUDENT);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      candidates: [{ teacherId: TEACHER_ID, name: null, department: null }],
    });
    expect(query.mock.calls[0]![1]).toContain("app.student_mentor_candidates()");
  });

  it.each(["mentorship-requests", "mentor-candidates"])(
    "%s: a teacher is 403, no session 401, another site 403, a failure 503",
    async (path) => {
      query.mockImplementationOnce(() => {
        throw refusal("ZD403");
      });
      expect((await get(path, STUDENT)).status).toBe(403);
      query.mockImplementationOnce(() => {
        throw refusal("ZD401");
      });
      expect((await get(path, STUDENT)).status).toBe(401);
      expect((await get(path)).status).toBe(401);
      expect((await get(path, STUDENT, "cross-site")).status).toBe(403);
      query.mockImplementationOnce(() => {
        throw new Error("connection lost");
      });
      expect((await get(path, STUDENT)).status).toBe(503);
      query.mockReturnValueOnce([row({ request: "not-a-uuid" })]);
      expect((await get(path, STUDENT)).status).toBe(503);
    },
  );
});

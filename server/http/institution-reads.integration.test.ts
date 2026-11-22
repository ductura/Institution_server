import { Value } from "@sinclair/typebox/value";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ActorTransaction, WithActor } from "../database/index.ts";

import { createDatabases } from "./databases.ts";
import { createInstitutionReadRoutesFor } from "./institution-reads.ts";
import { createLayers } from "./pipeline.ts";
import { startServer, type Running } from "./start.ts";

const COURSE = "00000000-0000-4000-8000-0000000000c1";
const GROUP = "00000000-0000-4000-8000-0000000000d1";
const ANA = "00000000-0000-4000-8000-0000000000a1";
const IVO = "00000000-0000-4000-8000-0000000000a2";
const TOKEN = "T".repeat(43);
const COOKIE = `__Host-ductus_session=${TOKEN}`;
const COURSES = "/api/v1/institution/admin/courses?academicYear=2026%2F2027";
const YEARS = "/api/v1/institution/admin/academic-years";
const TEACHERS = "/api/v1/institution/teachers";
// The column name of institution-courses.ts COURSES, kept as the database
// returns it; a computed key, since user_id is no camelCase property name.
const USER_ID = "user_id";
const none = {
  group_id: null,
  group_name: null,
  [USER_ID]: null,
  given_name: null,
  family_name: null,
};

const query = vi.fn();
const withActor: WithActor = (token, run) =>
  run({ query: query.bind(null, token) } as ActorTransaction);
const routes = createInstitutionReadRoutesFor({ withActor });
let server: Running;

beforeEach(async () => {
  query.mockReset().mockResolvedValue({ rows: [] });
  vi.spyOn(console, "error").mockImplementation(() => {});
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    layers: createLayers({ expectedOrigin: "https://ductura.example.invalid" }),
    databases: createDatabases(),
    routes,
  });
});
afterEach(async () => {
  await server.close();
  vi.restoreAllMocks();
});

function get(path: string, headers: Record<string, string> = { cookie: COOKIE }) {
  return fetch(`http://127.0.0.1:${server.port}${path}`, { headers });
}

function bodyChecks(index: number, body: unknown) {
  return Value.Check(routes[index]!.contract.responses[0]!.body!, body);
}

describe.each([COURSES, YEARS, TEACHERS])("%s", (path) => {
  it.each([
    [{}, 401],
    [{ cookie: "malformed" }, 401],
    [{ cookie: COOKIE, "sec-fetch-site": "cross-site" }, 403],
    [{ cookie: COOKIE, "sec-fetch-site": "same-origin, same-origin" }, 403],
  ] satisfies [Record<string, string>, number][])(
    "refuses headers %j before SQL",
    async (headers, status) => {
      expect((await get(path, headers)).status).toBe(status);
      expect(query).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["ZD401", 401],
    ["ZD403", 403],
    ["57P01", 503],
  ])("maps database failure %s to %s without its detail", async (code, status) => {
    query.mockRejectedValue(Object.assign(new Error("invented private detail"), { code }));
    const answer = await get(path);
    expect(answer.status).toBe(status);
    expect(await answer.text()).not.toContain("invented private detail");
  });

  it("refuses an extra query key before SQL", async () => {
    const extra = path.includes("?") ? `${path}&x=1` : `${path}?x=1`;
    expect((await get(extra)).status).toBe(422);
    expect(query).not.toHaveBeenCalled();
  });
});

it.each([
  "/api/v1/institution/admin/courses",
  "/api/v1/institution/admin/courses?academicYear=2026%2F2027&academicYear=2026%2F2027",
  "/api/v1/institution/admin/courses?academicYear=2026%2F2028",
])("refuses the academic year of %s before SQL", async (path) => {
  expect((await get(path)).status).toBe(422);
  expect(query).not.toHaveBeenCalled();
});

it("returns the courses of the year with holder, team and groups", async () => {
  query.mockResolvedValue({
    rows: [
      { kind: "course", course_id: COURSE, course_name: "Kolegij A", students: 3, ...none },
      {
        kind: "group",
        course_id: COURSE,
        course_name: null,
        group_id: GROUP,
        group_name: "Grupa 1",
        students: 2,
        [USER_ID]: null,
        given_name: null,
        family_name: null,
      },
      {
        kind: "holder",
        course_id: COURSE,
        course_name: null,
        group_id: null,
        group_name: null,
        students: null,
        [USER_ID]: ANA,
        given_name: "Ana",
        family_name: "Horvat",
      },
      {
        kind: "team",
        course_id: COURSE,
        course_name: null,
        group_id: null,
        group_name: null,
        students: null,
        [USER_ID]: IVO,
        given_name: null,
        family_name: null,
      },
      {
        kind: "group_teacher",
        course_id: COURSE,
        course_name: null,
        group_id: GROUP,
        group_name: null,
        students: null,
        [USER_ID]: IVO,
        given_name: null,
        family_name: null,
      },
    ],
  });
  const answer = await get(COURSES);
  const body: unknown = await answer.json();
  expect(answer.status).toBe(200);
  expect(answer.headers.get("cache-control")).toBe("no-store");
  expect(query).toHaveBeenCalledExactlyOnceWith(TOKEN, expect.any(String), ["2026/2027"]);
  const ivo = { personId: IVO, name: null };
  expect(body).toEqual({
    academicYear: "2026/2027",
    courses: [
      {
        courseId: COURSE,
        name: "Kolegij A",
        students: 3,
        holder: { personId: ANA, name: { givenName: "Ana", familyName: "Horvat" } },
        team: [ivo],
        groups: [{ groupId: GROUP, name: "Grupa 1", students: 2, teachers: [ivo] }],
      },
    ],
  });
  expect(bodyChecks(0, body)).toBe(true);
  query.mockResolvedValue({ rows: [{ kind: "nepoznato" }] });
  expect((await get(COURSES)).status).toBe(503);
});

it("returns the academic years newest first", async () => {
  query.mockResolvedValue({
    rows: [{ academic_year: "2025/2026" }, { academic_year: "2026/2027" }],
  });
  const answer = await get(YEARS);
  const body: unknown = await answer.json();
  expect(answer.status).toBe(200);
  expect(answer.headers.get("cache-control")).toBe("no-store");
  expect(body).toEqual({ years: ["2026/2027", "2025/2026"] });
  expect(bodyChecks(1, body)).toBe(true);
});

it("returns the pending and confirmed teachers", async () => {
  query.mockResolvedValue({
    rows: [
      {
        [USER_ID]: ANA,
        list: "candidate",
        given_name: "Ana",
        family_name: "Horvat",
        confirmed_at: null,
        revoked_at: null,
        for_review: null,
      },
      {
        [USER_ID]: IVO,
        list: "confirmed",
        given_name: "Ivo",
        family_name: "Kovač",
        confirmed_at: new Date("2026-11-20T12:34:00.000Z"),
        revoked_at: null,
        for_review: true,
      },
    ],
  });
  const answer = await get(TEACHERS);
  const body: unknown = await answer.json();
  expect(answer.status).toBe(200);
  expect(answer.headers.get("cache-control")).toBe("no-store");
  expect(body).toEqual({
    pending: [{ personId: ANA, name: { givenName: "Ana", familyName: "Horvat" }, revokedAt: null }],
    confirmed: [
      {
        personId: IVO,
        name: { givenName: "Ivo", familyName: "Kovač" },
        confirmedAt: "2026-11-20T12:34:00.000Z",
        forReview: true,
      },
    ],
  });
  expect(bodyChecks(2, body)).toBe(true);
});

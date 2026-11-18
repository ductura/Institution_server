// DAN-1089 (contract Ductus#2028 c.6968016327): the two reads of A-03 on a
// real server with the real pipeline over a fake course port. Every vector of
// both routes is sent and answered exactly; a refusal before the port (no
// session, cross-site, a query that is not exactly one academicYear) leaves it
// uncalled. All values are invented.
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import type {
  AcademicYearsOutcome,
  InstitutionCourseReads,
  InstitutionCoursesOutcome,
} from "../database/index.ts";

import { createDatabases } from "./databases.ts";
import { createInstitutionCourseReadRoutes } from "./institution-course-reads.ts";
import { createLayers } from "./pipeline.ts";
import { type Running, startServer } from "./start.ts";

type Vector = {
  name: string;
  request: { headers?: Record<string, string>; query?: Record<string, string> };
  response: { status: number; body: Record<string, unknown> };
};
const vectorsOf = (route: string) =>
  (
    JSON.parse(
      readFileSync(new URL(`../contracts/vectors/${route}.json`, import.meta.url), "utf8"),
    ) as { vectors: Vector[] }
  ).vectors;
const YEARS = vectorsOf("institution.academic-years.get");
const COURSES = vectorsOf("institution.course-list.get");
const TOKEN = YEARS[0]!.request.headers!.cookie!.slice("__Host-ductus_session=".length);
const YEAR = "2026/2027";

/** What the port answers for a vector, by its name; a name not here never reaches the port. */
const YEAR_OUTCOMES: Record<string, AcademicYearsOutcome> = {
  years: { status: "ok", years: YEARS[0]!.response.body.years as string[] },
  "no-years": { status: "ok", years: [] },
  "not-administrator": { status: "forbidden" },
  unavailable: { status: "unavailable" },
};
const COURSE_OUTCOMES: Record<string, InstitutionCoursesOutcome> = {
  courses: {
    status: "ok",
    ...(COURSES[0]!.response.body as { academicYear: string; courses: [] }),
  },
  "no-courses": { status: "ok", academicYear: YEAR, courses: [] },
  "not-administrator": { status: "forbidden" },
  unavailable: { status: "unavailable" },
};

let server: Running | undefined;
const calls: unknown[][] = [];
let yearAnswer: AcademicYearsOutcome = { status: "unavailable" };
let courseAnswer: InstitutionCoursesOutcome = { status: "unavailable" };

async function start() {
  const reads: InstitutionCourseReads = {
    readAcademicYears: async (token) => (calls.push(["years", token]), yearAnswer),
    readCourses: async (token, year) => (calls.push(["courses", token, year]), courseAnswer),
  };
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    layers: createLayers({ expectedOrigin: "https://ductura.example.invalid" }),
    databases: createDatabases(),
    routes: createInstitutionCourseReadRoutes(reads),
  });
}
afterEach(async () => {
  calls.length = 0;
  await server?.close();
  server = undefined;
});

type Answer = { status: number; headers: Record<string, unknown>; body: Record<string, unknown> };
function get(path: string, headers: Record<string, string | string[]> = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port: server!.port, method: "GET", path, headers },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (text += chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: JSON.parse(text) as Record<string, unknown>,
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}
const pathOf = (base: string, query?: Record<string, string>) =>
  query === undefined ? base : `${base}?${new URLSearchParams(query).toString()}`;

async function check(v: Vector, base: string) {
  const got = await get(pathOf(base, v.request.query), v.request.headers);
  expect(got.status).toBe(v.response.status);
  expect(String(got.headers["content-type"]).split(";")[0]).toBe("application/json");
  expect(got.headers["cache-control"]).toBe("no-store");
  if (got.status === 200) expect(got.body).toEqual(v.response.body);
  else expect(got.body).toEqual({ ...v.response.body, requestId: got.headers["x-request-id"] });
}

describe("every vector of institution.academic-years.get", () => {
  it.each(YEARS.map((v) => [v.name, v] as const))("%s", async (name, v) => {
    yearAnswer = YEAR_OUTCOMES[name] ?? { status: "unavailable" };
    await start();
    await check(v, "/api/v1/institution/academic-years");
    expect(calls).toEqual(name in YEAR_OUTCOMES ? [["years", TOKEN]] : []);
  });
});

describe("every vector of institution.course-list.get", () => {
  it.each(COURSES.map((v) => [v.name, v] as const))("%s", async (name, v) => {
    courseAnswer = COURSE_OUTCOMES[name] ?? { status: "unavailable" };
    await start();
    await check(v, "/api/v1/institution/course-list");
    expect(calls).toEqual(name in COURSE_OUTCOMES ? [["courses", TOKEN, YEAR]] : []);
  });
});

describe("the query of course-list", () => {
  const cookie = { cookie: `__Host-ductus_session=${TOKEN}` };
  it.each([
    ["a repeated year", "academicYear=2026%2F2027&academicYear=2026%2F2027"],
    ["another parameter", "academicYear=2026%2F2027&institution=x"],
    ["another name", "godina=2026%2F2027"],
    ["a plus for the slash", "academicYear=2026+2027"],
    ["an empty year", "academicYear="],
    ["a bare key", "academicYear"],
  ])("refuses %s without the port (422)", async (_label, query) => {
    await start();
    const got = await get(`/api/v1/institution/course-list?${query}`, cookie);
    expect([got.status, got.body.code]).toEqual([422, "invalid_input"]);
    expect(calls).toEqual([]);
  });

  it("passes a year the port refuses (ZD422) as 422, and a fault of the port as 503", async () => {
    courseAnswer = { status: "invalid" };
    await start();
    const year = await get(
      pathOf("/api/v1/institution/course-list", { academicYear: YEAR }),
      cookie,
    );
    expect([year.status, year.body.code]).toEqual([422, "invalid_input"]);
    await server!.close();
    server = undefined;
    const reads = {
      readAcademicYears: () => Promise.reject(new Error("izmisljeni kvar")),
      readCourses: () => Promise.reject(new Error("izmisljeni kvar")),
    };
    server = await startServer({
      host: "127.0.0.1",
      port: 0,
      layers: createLayers({ expectedOrigin: "https://ductura.example.invalid" }),
      databases: createDatabases(),
      routes: createInstitutionCourseReadRoutes(reads),
    });
    const fault = await get("/api/v1/institution/academic-years", cookie);
    expect([fault.status, fault.body.code]).toEqual([503, "unavailable"]);
    expect(JSON.stringify(fault.body)).not.toContain("izmisljeni kvar");
  });
});

describe("refusals before the port on both routes", () => {
  const paths = [
    "/api/v1/institution/academic-years",
    "/api/v1/institution/course-list?academicYear=2026/2027",
  ];
  const cookie = `__Host-ductus_session=${TOKEN}`;

  it("an unencoded slash in the year is the same year", async () => {
    courseAnswer = COURSE_OUTCOMES["no-courses"]!;
    await start();
    const got = await get(paths[1]!, { cookie });
    expect([got.status, got.body]).toEqual([200, { academicYear: YEAR, courses: [] }]);
    expect(calls).toEqual([["courses", TOKEN, YEAR]]);
  });

  it("a session this browser ended reads as none (401)", async () => {
    const { sessionTag } = await import("../session/index.ts");
    const tag = sessionTag(TOKEN)!;
    await start();
    for (const path of paths) {
      for (const mark of [`ductus-ended-${tag}=1`, `ductus-ended=aaaa.${tag}`]) {
        const got = await get(path, { cookie: `${cookie}; ${mark}` });
        expect([got.status, got.body.code]).toEqual([401, "unauthorized"]);
      }
    }
    expect(calls).toEqual([]);
  });

  it("any Sec-Fetch-Site but one same-origin is 403", async () => {
    await start();
    for (const path of paths) {
      for (const site of ["same-site", "none", "cross-site", ["same-origin", "same-origin"]]) {
        const got = await get(path, { cookie, "sec-fetch-site": site });
        expect([got.status, got.body.code]).toEqual([403, "forbidden"]);
      }
    }
    expect(calls).toEqual([]);
  });
});

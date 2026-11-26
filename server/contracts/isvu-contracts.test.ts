// SRV-V22-05 / F4-V18-22-R06: guards of the ISVU source contract. The routes
// read only the TRIAL source, hide themselves (404) when the institution's
// setting is off, take no grade and no secret, and the vectors keep to invented
// data. Bad input is refused by the schema itself.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { ROUTES } from "./index.ts";
import {
  ISVU_COURSES_MAX,
  isvuCoursesGet,
  isvuRosterImportsPost,
  isvuSourceRoutes,
} from "./routes/index.ts";

const ID = "00000000-0000-4000-8000-00000000b301";
const VECTORS = join(import.meta.dirname, "vectors");

const okQuery = (value: unknown) => Value.Check(isvuCoursesGet.request.query!, value);
const okBody = (value: unknown) => Value.Check(isvuRosterImportsPost.request.body!, value);
const okParams = (value: unknown) => Value.Check(isvuRosterImportsPost.request.params!, value);
const okCourses = (value: unknown) => Value.Check(isvuCoursesGet.responses[0]!.body!, value);

function keysOf(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const item of value) keysOf(item, into);
  else if (typeof value === "object" && value !== null)
    for (const [key, inner] of Object.entries(value)) {
      into.add(key);
      keysOf(inner, into);
    }
  return into;
}
const schemaKeys = (schema: unknown) => keysOf(JSON.parse(JSON.stringify(schema)));

describe("ISVU source contract", () => {
  it("has exactly the two routes, both for an institution administrator and both in ROUTES", () => {
    expect(isvuSourceRoutes.map((r) => r.id)).toEqual([
      "institution.isvu-courses.get",
      "institution.isvu-roster-imports.post",
    ]);
    for (const route of isvuSourceRoutes) {
      expect(route.access).toBe("institution_admin");
      expect(ROUTES.map((r) => r.id)).toContain(route.id);
      expect(route.errors.map((e) => e.status)).toContain(404);
      expect(route.summary).toMatch(/not reveal|ordinary 404|not_found/u);
    }
    expect(isvuCoursesGet.method).toBe("GET");
    expect(isvuRosterImportsPost.method).toBe("POST");
  });

  it("takes exactly academicYear YYYY/YYYY and nothing else", () => {
    expect(okQuery({ academicYear: "2026/2027" })).toBe(true);
    expect(okQuery({})).toBe(false);
    expect(okQuery({ academicYear: "2026" })).toBe(false);
    expect(okQuery({ academicYear: "2026/2027\n" })).toBe(false);
    expect(okQuery({ academicYear: "2026/2027", extra: "1" })).toBe(false);
  });

  it("takes exactly a safe sourceCourseKey and a course id", () => {
    expect(okBody({ sourceCourseKey: "SYN-101" })).toBe(true);
    expect(okBody({ sourceCourseKey: "a.b_c-1" })).toBe(true);
    expect(okBody({ sourceCourseKey: "" })).toBe(false);
    expect(okBody({ sourceCourseKey: "x".repeat(65) })).toBe(false);
    expect(okBody({ sourceCourseKey: "SYN 101" })).toBe(false);
    expect(okBody({ sourceCourseKey: "../etc" })).toBe(false);
    expect(okBody({ sourceCourseKey: "SYN-101\n" })).toBe(false);
    expect(okBody({ sourceCourseKey: "SYN-101", grades: [] })).toBe(false);
    expect(okBody({})).toBe(false);
    expect(okParams({ courseId: ID })).toBe(true);
    expect(okParams({ courseId: "nije-id" })).toBe(false);
  });

  it("answers mode mock only, with a bounded list and no names of students", () => {
    const course = {
      sourceCourseKey: "SYN-1",
      name: "Izmišljeni",
      academicYear: "2026/2027",
      enrolledCount: 3,
    };
    expect(okCourses({ mode: "mock", courses: [course] })).toBe(true);
    expect(okCourses({ mode: "real", courses: [] })).toBe(false);
    expect(okCourses({ mode: "off", courses: [] })).toBe(false);
    expect(okCourses({ mode: "mock", courses: [{ ...course, students: [] }] })).toBe(false);
    expect(okCourses({ mode: "mock", courses: [{ ...course, enrolledCount: -1 }] })).toBe(false);
    expect(
      okCourses({
        mode: "mock",
        courses: Array.from({ length: ISVU_COURSES_MAX + 1 }, () => course),
      }),
    ).toBe(false);
  });

  it("has no grade, secret or address field in any request or response", () => {
    const forbidden = /grade|ocjen|password|lozinka|token|secret|apiKey|url|host/iu;
    const schemas = [
      isvuCoursesGet.request.query,
      isvuRosterImportsPost.request.body,
      isvuRosterImportsPost.request.params,
      ...isvuSourceRoutes.flatMap((r) => r.responses.map((x) => x.body)),
    ];
    const keys = new Set<string>();
    for (const schema of schemas) for (const key of schemaKeys(schema)) keys.add(key);
    for (const key of ["properties", "required", "anyOf", "type", "const", "pattern"])
      keys.delete(key);
    expect([...keys].filter((key) => forbidden.test(key))).toEqual([]);
  });

  it("keeps the vectors to invented data and to the trial source", () => {
    for (const route of isvuSourceRoutes) {
      const text = readFileSync(join(VECTORS, `${route.id}.json`), "utf8");
      expect(JSON.parse(text).route).toBe(route.id);
      const addresses = text.match(/https?:\/\/[^"/\s]+/giu) ?? [];
      expect(addresses.filter((a) => !a.endsWith(".invalid"))).toEqual([]);
      expect(text).not.toMatch(/isvu\.(?:hr|srce\.hr)|studomat/iu);
      expect(text).not.toMatch(/"(?:grade|password|token)"/iu);
    }
    const courses = JSON.parse(
      readFileSync(join(VECTORS, "institution.isvu-courses.get.json"), "utf8"),
    ) as {
      vectors: { kind: string; response: { status: number; body?: unknown } }[];
    };
    const ok = courses.vectors.filter((v) => v.response.status === 200);
    expect(ok.length).toBeGreaterThan(0);
    for (const vector of ok) expect(okCourses(vector.response.body)).toBe(true);
    expect(courses.vectors.some((v) => v.response.status === 404)).toBe(true);
  });
});

// SRV-12: POST /api/v1/institution/admin/courses on a real server with the
// real pipeline, over a fake AdminCourses port. Every vector that does not
// frame the body itself is sent; until the database gives the administrator
// the groups, a course with groups is 422 before the port. All values are
// invented.
import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import type { AdminCourseInput, AdminCourseOutcome } from "../database/index.ts";

import { createAdminCourseRoute, parseAdminCourseBody } from "./admin-courses.ts";
import { createDatabases } from "./databases.ts";
import { createLayers } from "./pipeline.ts";
import { type Running, startServer } from "./start.ts";

type Vector = {
  name: string;
  kind: "success" | "error";
  code?: string;
  request: { headers: Record<string, string>; body?: unknown; rawBody?: string };
  response: { status: number; body: Record<string, unknown> };
};
const VECTORS = (
  JSON.parse(
    readFileSync(
      new URL("../contracts/vectors/institution.admin-courses.post.json", import.meta.url),
      "utf8",
    ),
  ) as { vectors: Vector[] }
).vectors;
const framed = (v: Vector) =>
  v.request.rawBody !== undefined || v.request.headers["content-length"] !== undefined;
const PORT_REFUSAL: ReadonlyMap<string, string> = new Map([
  ["forbidden", "forbidden"],
  ["conflict", "conflict"],
  ["unavailable", "unavailable"],
  ["unauthorized", "unauthenticated"],
]);
const ORIGIN = VECTORS[0]!.request.headers.origin!;
const PATH = "/api/v1/institution/admin/courses";

let server: Running | undefined;
const calls: [string, AdminCourseInput][] = [];
const activity: string[] = [];
let answer: () => AdminCourseOutcome;

async function start() {
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    layers: createLayers({ expectedOrigin: ORIGIN }),
    databases: createDatabases(),
    routes: [
      createAdminCourseRoute({
        courses: {
          createCourse: async (token, course) => {
            calls.push([token, course]);
            return answer();
          },
        },
        recordActivity: async (token) => {
          activity.push(token);
        },
        timeoutMs: 300,
      }),
    ],
  });
}
afterEach(async () => {
  calls.length = 0;
  activity.length = 0;
  await server?.close();
  server = undefined;
});

async function send(v: Vector, body = v.request.body) {
  const got = await fetch(`http://127.0.0.1:${server!.port}${PATH}`, {
    method: "POST",
    headers: v.request.headers,
    body: JSON.stringify(body),
  });
  return { status: got.status, body: (await got.json()) as Record<string, unknown> };
}
const withoutRequestId = (body: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(body).filter(([k]) => k !== "requestId"));

describe("POST /api/v1/institution/admin/courses", () => {
  // "created" names two groups, which the administrator cannot make yet (see the route).
  it.each(
    VECTORS.filter((v) => !framed(v) && v.name !== "created").map((v) => [v.name, v] as const),
  )("answers the %s vector", async (_name, v) => {
    answer =
      v.kind === "success"
        ? () => ({ status: "created", id: v.response.body.id as string })
        : () =>
            ({
              status: PORT_REFUSAL.get(v.code!) ?? "unexpected",
              reason: "database_error",
            }) as AdminCourseOutcome;
    await start();
    // A refusal the database decides is asked with a body the route passes on.
    const byPort = v.kind === "error" && PORT_REFUSAL.has(v.code!);
    const body = v.request.body as Record<string, unknown> | undefined;
    const got = await send(v, byPort && body !== undefined ? { ...body, groups: [] } : body);
    expect([got.status, withoutRequestId(got.body)]).toEqual([
      v.response.status,
      withoutRequestId(v.response.body),
    ]);
    expect(activity).toEqual(v.kind === "success" ? [expect.any(String)] : []);
  });

  it("the holder in lower case reaches the port; a course with groups is 422 before it", async () => {
    const v = VECTORS.find((x) => x.name === "created-without-groups")!;
    answer = () => ({ status: "created", id: v.response.body.id as string });
    await start();
    const body = v.request.body as Record<string, unknown>;
    const holder = body.holderId as string;
    expect((await send(v, { ...body, holderId: holder.toUpperCase() })).status).toBe(200);
    const course = Object.fromEntries(Object.entries(body).filter(([k]) => k !== "groups"));
    expect(calls).toEqual([[expect.any(String), { ...course, holderId: holder }]]);
    calls.length = 0;
    expect((await send(VECTORS.find((x) => x.name === "created")!)).status).toBe(422);
    expect(calls).toEqual([]);
  });
});

describe("parseAdminCourseBody", () => {
  const good = {
    name: "Izmišljeni seminar",
    academicYear: "2026/2027",
    aiPolicy: "prohibited",
    holderId: "8f2b3c4d-5e6f-4a71-9b82-c3d4e5f60702",
    groups: [],
  };
  it("takes exactly the five keys, groups empty", () => {
    const course = Object.fromEntries(Object.entries(good).filter(([k]) => k !== "groups"));
    expect(parseAdminCourseBody(good)).toEqual(course);
  });
  it.each([
    ["no groups key", { ...good, groups: undefined }],
    ["an extra key", { ...good, courseId: "x" }],
    ["a holder that is not a UUID", { ...good, holderId: "x" }],
    ["a year that is not consecutive", { ...good, academicYear: "2026/2028" }],
    ["a name with an edge space", { ...good, name: " X" }],
    ["groups", { ...good, groups: ["Grupa A"] }],
  ])("refuses %s", (_name, value) => {
    expect(parseAdminCourseBody(JSON.parse(JSON.stringify(value)))).toBeNull();
  });
});

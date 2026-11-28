// SRV-12: POST /api/v1/institution/admin/courses on a real server with the
// real pipeline, over a fake AdminCourses port. Every vector that does not
// frame the body itself is sent, groups included (F4 wave 2 #9, 1.9). All
// values are invented.
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
  const created = (v: Vector): AdminCourseOutcome => ({
    status: "created",
    id: v.response.body.id as string,
    groups: v.response.body.groups as { id: string; name: string }[],
  });

  it.each(VECTORS.filter((v) => !framed(v)).map((v) => [v.name, v] as const))(
    "answers the %s vector",
    async (_name, v) => {
      answer =
        v.kind === "success"
          ? () => created(v)
          : () =>
              ({
                status: PORT_REFUSAL.get(v.code!) ?? "unexpected",
                reason: "database_error",
              }) as AdminCourseOutcome;
      await start();
      const got = await send(v);
      expect([got.status, withoutRequestId(got.body)]).toEqual([
        v.response.status,
        withoutRequestId(v.response.body),
      ]);
      expect(activity).toEqual(v.kind === "success" ? [expect.any(String)] : []);
    },
  );

  it("the holder in lower case and the groups in order reach the port", async () => {
    const v = VECTORS.find((x) => x.name === "created")!;
    answer = () => created(v);
    await start();
    const body = v.request.body as Record<string, unknown>;
    const holder = body.holderId as string;
    expect((await send(v, { ...body, holderId: holder.toUpperCase() })).status).toBe(200);
    expect(calls).toEqual([[expect.any(String), { ...body, holderId: holder }]]);
  });

  it.each([
    ["21 groups", Array.from({ length: 21 }, (_, i) => `Grupa ${i + 1}`)],
    ["a group named twice", ["Grupa A", "Grupa A"]],
    ["a group name with an edge space", ["Grupa A "]],
  ])("%s is 422 before the port", async (_name, groups) => {
    const v = VECTORS.find((x) => x.name === "created")!;
    answer = () => ({ status: "unavailable", reason: "never" });
    await start();
    const got = await send(v, { ...(v.request.body as object), groups });
    expect([got.status, got.body.code]).toEqual([422, "invalid_input"]);
    expect(calls).toEqual([]);
  });

  it("a name the database refuses is 422", async () => {
    const v = VECTORS.find((x) => x.name === "created")!;
    answer = () => ({ status: "invalid" });
    await start();
    const got = await send(v);
    expect([got.status, got.body.code]).toEqual([422, "invalid_input"]);
    expect(activity).toEqual([]);
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
    expect(parseAdminCourseBody(good)).toEqual(good);
  });
  it("takes up to 20 distinct group names of 1 to 80 units", () => {
    const groups = Array.from(
      { length: 20 },
      (_, i) => "G".repeat(78) + String(i).padStart(2, "0"),
    );
    expect(parseAdminCourseBody({ ...good, groups })).toEqual({ ...good, groups });
  });
  it.each([
    ["no groups key", { ...good, groups: undefined }],
    ["an extra key", { ...good, courseId: "x" }],
    ["a holder that is not a UUID", { ...good, holderId: "x" }],
    ["a year that is not consecutive", { ...good, academicYear: "2026/2028" }],
    ["a name with an edge space", { ...good, name: " X" }],
    ["groups that is not an array", { ...good, groups: "Grupa A" }],
    ["21 groups", { ...good, groups: Array.from({ length: 21 }, (_, i) => `Grupa ${i}`) }],
    ["an empty group name", { ...good, groups: [""] }],
    ["a group name of 81 units", { ...good, groups: ["G".repeat(81)] }],
    ["a group name with an edge space", { ...good, groups: [" Grupa A"] }],
    ["a group name that is not a string", { ...good, groups: [1] }],
    ["a group named twice", { ...good, groups: ["Grupa A", "Grupa B", "Grupa A"] }],
  ])("refuses %s", (_name, value) => {
    expect(parseAdminCourseBody(JSON.parse(JSON.stringify(value)))).toBeNull();
  });
});

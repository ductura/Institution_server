// SRV-15: POST …/courses/{courseId}/groups and …/groups/{groupId}/teachers on
// a real server with the real pipeline, over a fake InstitutionGroups port. Every vector that does not frame the body itself (those are the
// shared reader's, institution-courses.integration.test.ts) is sent, with the
// port's outcome for its refusal; a refusal before the port leaves it
// uncalled. All values are invented.
import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import type {
  GroupCreateOutcome,
  GroupTeacherOutcome,
  InstitutionGroups,
} from "../database/index.ts";

import { createDatabases } from "./databases.ts";
import { createInstitutionGroupRoutes } from "./institution-groups.ts";
import { createLayers } from "./pipeline.ts";
import { type Running, startServer } from "./start.ts";

type Vector = {
  name: string;
  kind: "success" | "error";
  code?: string;
  request: {
    params: Record<string, string>;
    headers: Record<string, string>;
    body?: unknown;
    rawBody?: string;
  };
  response: { status: number; body: Record<string, unknown> };
};
const vectorsOf = (id: string): Vector[] =>
  (
    JSON.parse(
      readFileSync(new URL(`../contracts/vectors/${id}.json`, import.meta.url), "utf8"),
    ) as { vectors: Vector[] }
  ).vectors;
const CREATE = vectorsOf("institution.course-groups.post");
const ASSIGN = vectorsOf("institution.course-group-teachers.post");
/** The body framing vectors: the shared JSON reader's, tested with the course routes. */
const framed = (v: Vector) =>
  v.request.rawBody !== undefined || v.request.headers["content-length"] !== undefined;

// What the port answers for each refusal the database decides.
const PORT_REFUSAL: ReadonlyMap<string, string> = new Map([
  ["forbidden", "forbidden"],
  ["unavailable", "unavailable"],
  ["unauthorized", "unauthenticated"],
]);

let server: Running | undefined;
const calls: unknown[][] = [];
const activity: string[] = [];
let createAnswer: () => GroupCreateOutcome;
let assignAnswer: () => GroupTeacherOutcome;

async function start(origin: string) {
  const groups = {
    createGroup: async (...args: unknown[]) => {
      calls.push(["create", ...args]);
      return createAnswer();
    },
    assignGroupTeacher: async (...args: unknown[]) => {
      calls.push(["assign", ...args]);
      return assignAnswer();
    },
  } as InstitutionGroups;
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    layers: createLayers({ expectedOrigin: origin }),
    databases: createDatabases(),
    routes: createInstitutionGroupRoutes({
      groups,
      recordActivity: async (token) => {
        activity.push(token);
      },
      timeoutMs: 300,
    }),
  });
}
afterEach(async () => {
  calls.length = 0;
  activity.length = 0;
  await server?.close();
  server = undefined;
});

async function send(path: string, v: Vector): Promise<{ status: number; body: unknown }> {
  const answer = await fetch(`http://127.0.0.1:${server!.port}${path}`, {
    method: "POST",
    headers: v.request.headers,
    body: JSON.stringify(v.request.body),
  });
  return { status: answer.status, body: await answer.json() };
}
const withoutRequestId = (body: unknown) =>
  Object.fromEntries(
    Object.entries(body as Record<string, unknown>).filter(([k]) => k !== "requestId"),
  );
const tokenOf = (v: Vector) => v.request.headers.cookie!.slice("__Host-ductus_session=".length);

describe.each([
  {
    route: "institution.course-groups.post",
    vectors: CREATE,
    path: (v: Vector) => `/api/v1/institution/courses/${v.request.params.courseId}/groups`,
    success: (v: Vector) => {
      createAnswer = () => ({ status: "created", id: v.response.body.id as string });
    },
    refuse: (status: string) => {
      createAnswer = () => ({ status, reason: "database_error" }) as GroupCreateOutcome;
    },
  },
  {
    route: "institution.course-group-teachers.post",
    vectors: ASSIGN,
    path: (v: Vector) =>
      `/api/v1/institution/groups/${encodeURIComponent(v.request.params.groupId!)}/teachers`,
    success: (v: Vector) => {
      assignAnswer = () => ({ status: "assigned", assigned: v.response.body.assigned as boolean });
    },
    refuse: (status: string) => {
      assignAnswer = () => ({ status, reason: "database_error" }) as GroupTeacherOutcome;
    },
  },
])("$route", ({ vectors, path, success, refuse }) => {
  const origin = vectors[0]!.request.headers.origin!;

  it.each(vectors.filter((v) => !framed(v)).map((v) => [v.name, v] as const))(
    "answers the %s vector",
    async (_name, v) => {
      if (v.kind === "success") success(v);
      else refuse(PORT_REFUSAL.get(v.code!) ?? "unexpected");
      await start(origin);
      const got = await send(path(v), v);
      expect([got.status, withoutRequestId(got.body)]).toEqual([
        v.response.status,
        withoutRequestId(v.response.body),
      ]);
      const asked = v.kind === "success" || PORT_REFUSAL.has(v.code!);
      const signedIn = v.request.headers.cookie !== undefined;
      const guarded = ["origin_missing", "origin_mismatch", "cross_site"].includes(v.code ?? "");
      expect(calls.length).toBe(asked && signedIn && !guarded ? 1 : 0);
      expect(activity).toEqual(v.kind === "success" ? [tokenOf(v)] : []);
    },
  );
});

describe("the arguments of the port", () => {
  it("create: the token, the course in lower case and the name; a name with edge space is 422", async () => {
    const v = CREATE.find((x) => x.kind === "success")!;
    createAnswer = () => ({ status: "created", id: v.response.body.id as string });
    await start(v.request.headers.origin!);
    const course = v.request.params.courseId!;
    expect(
      (await send(`/api/v1/institution/courses/${course.toUpperCase()}/groups`, v)).status,
    ).toBe(200);
    expect(calls).toEqual([
      ["create", tokenOf(v), course, (v.request.body as { name: string }).name],
    ]);
    calls.length = 0;
    const spaced = { ...v, request: { ...v.request, body: { name: "Grupa C " } } };
    expect((await send(`/api/v1/institution/courses/${course}/groups`, spaced)).status).toBe(422);
    expect(calls).toEqual([]);
  });

  it("assign: the group and teacher in lower case; another key is 422 before the port", async () => {
    const v = ASSIGN.find((x) => x.kind === "success")!;
    assignAnswer = () => ({ status: "assigned", assigned: true });
    await start(v.request.headers.origin!);
    const group = v.request.params.groupId!;
    const teacher = (v.request.body as { teacherId: string }).teacherId;
    const upper = { ...v, request: { ...v.request, body: { teacherId: teacher.toUpperCase() } } };
    expect((await send(`/api/v1/institution/groups/${group}/teachers`, upper)).status).toBe(200);
    expect(calls).toEqual([["assign", tokenOf(v), group, teacher]]);
    calls.length = 0;
    const other = { ...v, request: { ...v.request, body: { studentId: teacher } } };
    expect((await send(`/api/v1/institution/groups/${group}/teachers`, other)).status).toBe(422);
    expect(calls).toEqual([]);
  });
});

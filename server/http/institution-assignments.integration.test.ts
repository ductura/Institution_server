// SRV-14: POST …/courses/{courseId}/assignments and …/assignments/{id}/versions
// on a real server with the real pipeline, over a fake InstitutionAssignments
// port. Every vector that does not frame the body itself (those are the
// shared reader's, institution-courses.integration.test.ts) is sent, with the
// port's outcome for its refusal; a refusal before the port leaves it
// uncalled. All values are invented.
import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import type {
  AssignmentContent,
  AssignmentCreateOutcome,
  AssignmentPublishOutcome,
  InstitutionAssignments,
} from "../database/index.ts";

import { createDatabases } from "./databases.ts";
import { createInstitutionAssignmentRoutes } from "./institution-assignments.ts";
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
const CREATE = vectorsOf("institution.course-assignments.post");
const PUBLISH = vectorsOf("institution.assignment-versions.post");
/** The body framing vectors: the shared JSON reader's, tested with the course routes. */
const framed = (v: Vector) =>
  v.request.rawBody !== undefined || v.request.headers["content-length"] !== undefined;

// What the port answers for each refusal the database decides.
const PORT_REFUSAL: ReadonlyMap<string, string> = new Map([
  ["forbidden", "forbidden"],
  ["conflict", "conflict"],
  ["version_conflict", "version_conflict"],
  ["unavailable", "unavailable"],
  ["unauthorized", "unauthenticated"],
]);

let server: Running | undefined;
const calls: unknown[][] = [];
const activity: string[] = [];
let createAnswer: () => AssignmentCreateOutcome;
let publishAnswer: () => AssignmentPublishOutcome;

async function start(origin: string) {
  const assignments = {
    createAssignment: async (...args: unknown[]) => {
      calls.push(["create", ...args]);
      return createAnswer();
    },
    publishVersion: async (...args: unknown[]) => {
      calls.push(["publish", ...args]);
      return publishAnswer();
    },
  } as InstitutionAssignments;
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    layers: createLayers({ expectedOrigin: origin }),
    databases: createDatabases(),
    routes: createInstitutionAssignmentRoutes({
      assignments,
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
const NO_SETUP = { externalToolsAllowed: false, aiSummaryOnly: false };
const tokenOf = (v: Vector) => v.request.headers.cookie!.slice("__Host-ductus_session=".length);

describe.each([
  {
    route: "institution.course-assignments.post",
    vectors: CREATE,
    path: (v: Vector) => `/api/v1/institution/courses/${v.request.params.courseId}/assignments`,
    success: (v: Vector) => {
      createAnswer = () => ({ status: "created", id: v.response.body.id as string });
    },
    refuse: (status: string) => {
      createAnswer = () => ({ status, reason: "database_error" }) as AssignmentCreateOutcome;
    },
  },
  {
    route: "institution.assignment-versions.post",
    vectors: PUBLISH,
    path: (v: Vector) =>
      `/api/v1/institution/assignments/${encodeURIComponent(v.request.params.assignmentId!)}/versions`,
    success: (v: Vector) => {
      publishAnswer = () => ({
        status: "published",
        versionNo: v.response.body.versionNo as number,
      });
    },
    refuse: (status: string) => {
      publishAnswer = () => ({ status, reason: "database_error" }) as AssignmentPublishOutcome;
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
      // The port is asked only once the session, ids, key and body pass;
      // a refusal the database decides comes from the port.
      const asked = v.kind === "success" || PORT_REFUSAL.has(v.code!);
      const signedIn = v.request.headers.cookie !== undefined;
      const guarded = ["origin_missing", "origin_mismatch", "cross_site"].includes(v.code ?? "");
      expect(calls.length).toBe(asked && signedIn && !guarded ? 1 : 0);
      expect(activity).toEqual(v.kind === "success" ? [tokenOf(v)] : []);
    },
  );
});

describe("the arguments of the port", () => {
  it("create: the session token, the course and key in lower case, the parsed content", async () => {
    const v = CREATE.find((x) => x.kind === "success")!;
    createAnswer = () => ({ status: "created", id: v.response.body.id as string });
    await start(v.request.headers.origin!);
    const { requestKey, ...content } = v.request.body as { requestKey: string } & AssignmentContent;
    const upper = {
      ...v,
      request: { ...v.request, body: { requestKey: requestKey.toUpperCase(), ...content } },
    };
    const course = v.request.params.courseId!;
    const path = `/api/v1/institution/courses/${course.toUpperCase()}/assignments`;
    expect((await send(path, upper)).status).toBe(201);
    expect(calls).toEqual([["create", tokenOf(v), course, requestKey, content, false, NO_SETUP]]);
  });

  it.each([
    [true, 201],
    [false, 201],
    [null, 422],
    ["true", 422],
    [1, 422],
    [{}, 422],
  ])("create: isPractice=%j returns %i", async (isPractice, status) => {
    const v = CREATE.find((x) => x.kind === "success")!;
    createAnswer = () => ({ status: "created", id: v.response.body.id as string });
    await start(v.request.headers.origin!);
    const body = { ...(v.request.body as Record<string, unknown>), isPractice };
    const path = `/api/v1/institution/courses/${v.request.params.courseId}/assignments`;
    expect((await send(path, { ...v, request: { ...v.request, body } })).status).toBe(status);
    expect(calls.map((args) => args[5])).toEqual(status === 201 ? [isPractice] : []);
  });

  // UGOVORI-API zs-2/zs-3 (INT-32: the teacher's form sends them and was 422).
  const setupCase = (extra: Record<string, unknown>, policy?: string) => {
    const v = CREATE.find((x) => x.kind === "success")!;
    const base = v.request.body as Record<string, unknown>;
    const body: Record<string, unknown> = {
      ...base,
      ...(policy === undefined ? {} : { aiPolicy: policy, aiPurposes: [] }),
      ...extra,
    };
    return { v, body };
  };
  it.each([
    [{ externalToolsAllowed: true }, { externalToolsAllowed: true, aiSummaryOnly: false }],
    [{ externalToolsAllowed: false }, NO_SETUP],
    [{ aiSummaryOnly: true }, { externalToolsAllowed: false, aiSummaryOnly: true }],
    [
      { externalToolsAllowed: true, aiSummaryOnly: true, groupIds: [] },
      { externalToolsAllowed: true, aiSummaryOnly: true },
    ],
  ])("create: %j is 201 and the port gets the rules %j", async (extra, setup) => {
    const { v, body } = setupCase(extra, "partially_allowed");
    createAnswer = () => ({ status: "created", id: v.response.body.id as string });
    await start(v.request.headers.origin!);
    const path = `/api/v1/institution/courses/${v.request.params.courseId}/assignments`;
    expect((await send(path, { ...v, request: { ...v.request, body } })).status).toBe(201);
    const setupKeys = new Set(["requestKey", "externalToolsAllowed", "aiSummaryOnly", "groupIds"]);
    const content = Object.fromEntries(Object.entries(body).filter(([k]) => !setupKeys.has(k)));
    expect(calls).toEqual([
      ["create", tokenOf(v), v.request.params.courseId, body.requestKey, content, false, setup],
    ]);
  });

  it.each([
    ["externalToolsAllowed null", { externalToolsAllowed: null }, undefined],
    ['externalToolsAllowed "true"', { externalToolsAllowed: "true" }, undefined],
    ["aiSummaryOnly 1", { aiSummaryOnly: 1 }, undefined],
    ["aiSummaryOnly under a prohibited policy", { aiSummaryOnly: true }, "prohibited"],
    [
      "aiSummaryOnly with a purpose",
      { aiSummaryOnly: true, aiPolicy: "partially_allowed", aiPurposes: ["proofreading"] },
      undefined,
    ],
    ["a group, not stored yet", { groupIds: ["00000000-0000-4000-8000-00000000a601"] }, undefined],
    ["groupIds that is not an array", { groupIds: {} }, undefined],
  ])("create: %s is 422 before the port", async (_name, extra, policy) => {
    const { v, body } = setupCase(extra, policy);
    await start(v.request.headers.origin!);
    const path = `/api/v1/institution/courses/${v.request.params.courseId}/assignments`;
    expect((await send(path, { ...v, request: { ...v.request, body } })).status).toBe(422);
    expect(calls).toEqual([]);
  });

  it("create: no key, or a key that is not a UUID, is 422 before the port", async () => {
    const v = CREATE.find((x) => x.kind === "success")!;
    await start(v.request.headers.origin!);
    const content = Object.fromEntries(
      Object.entries(v.request.body as Record<string, unknown>).filter(([k]) => k !== "requestKey"),
    );
    const path = `/api/v1/institution/courses/${v.request.params.courseId}/assignments`;
    for (const body of [content, { ...content, requestKey: "x" }]) {
      expect((await send(path, { ...v, request: { ...v.request, body } })).status).toBe(422);
    }
    expect(calls).toEqual([]);
  });

  it("publish: the expected version and the content without it", async () => {
    const v = PUBLISH.find((x) => x.kind === "success")!;
    publishAnswer = () => ({ status: "published", versionNo: v.response.body.versionNo as number });
    await start(v.request.headers.origin!);
    expect(
      (await send(`/api/v1/institution/assignments/${v.request.params.assignmentId}/versions`, v))
        .status,
    ).toBe(201);
    const { expectedVersion, ...content } = v.request.body as Record<string, unknown>;
    expect(calls).toEqual([
      ["publish", tokenOf(v), v.request.params.assignmentId, expectedVersion, content],
    ]);
  });
});

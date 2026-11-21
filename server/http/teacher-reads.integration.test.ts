// The teacher's reads on a real server with the real pipeline, over fake
// readers: every vector of the five contracts a socket can reach is sent as
// its bytes; a refusal before the reader leaves it uncalled. Port of the HTTP
// edge of Ductus teacher-courses.ts, mentored-works.ts and
// assignment-submissions.ts at 078c780. All values are invented.
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { connect } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  AssignmentSubmission,
  AssignmentSubmissionsOutcome,
  MentoredWorkOutcome,
  MentoredWorksOutcome,
  TeacherAccessResult,
  TeacherCoursesResult,
} from "../database/index.ts";

import { principalScope } from "../session/index.ts";

import { createDatabases } from "./databases.ts";
import { createLayers } from "./pipeline.ts";
import { type Running, startServer } from "./start.ts";
import {
  createTeacherAccessRoute,
  createTeacherCoursesRoute,
  createTeacherReadRoutes,
  parseAssignmentIdsBody,
} from "./teacher-reads.ts";

type Vector = {
  name: string;
  request: {
    params?: Record<string, string>;
    headers?: Record<string, string>;
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
const ORIGIN = "https://ductura.example.invalid";

let server: Running | undefined;
const calls: unknown[][] = [];
let courses: TeacherCoursesResult | undefined;
let access: () => Promise<TeacherAccessResult>;
let works: MentoredWorksOutcome = { status: "unavailable" };
let work: MentoredWorkOutcome = { status: "unavailable" };
let submissions: AssignmentSubmissionsOutcome = { status: "unavailable", reason: "x" };

async function start() {
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    layers: createLayers({ expectedOrigin: ORIGIN }),
    databases: createDatabases(),
    routes: [
      createTeacherCoursesRoute(async (token) => {
        calls.push(["courses", token]);
        if (courses === undefined) throw new Error("test reader failure");
        return courses;
      }),
      createTeacherAccessRoute(async (token) => {
        reads.push(token);
        return access();
      }),
      ...createTeacherReadRoutes({
        mentored: {
          readMentoredWorks: async (token) => {
            calls.push(["works", token]);
            return works;
          },
          readMentoredWork: async (token, id) => {
            calls.push(["work", token, id]);
            return work;
          },
        },
        submissions: async (token, ids) => {
          calls.push(["submissions", token, ids]);
          return submissions;
        },
        timeoutMs: 300,
      }),
    ],
  });
}
afterEach(async () => {
  calls.length = 0;
  reads.length = 0;
  vi.restoreAllMocks();
  await server?.close();
  server = undefined;
});

type Answer = { status: number; head: Record<string, string>; body: string };
function send(raw: Buffer): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const socket = connect(server!.port, "127.0.0.1");
    let text = "";
    socket.write(raw);
    const finish = (): Answer => {
      const [head = "", ...rest] = text.split("\r\n\r\n");
      const headers: Record<string, string> = {};
      for (const field of head.split("\r\n").slice(1)) {
        const at = field.indexOf(":");
        headers[field.slice(0, at).toLowerCase()] = field.slice(at + 1).trim();
      }
      return { status: Number(head.split(" ")[1]), head: headers, body: rest.join("\r\n\r\n") };
    };
    socket.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
      if (!text.includes("\r\n\r\n")) return;
      const got = finish();
      if (Buffer.byteLength(got.body) >= Number(got.head["content-length"] ?? 0)) {
        socket.destroy();
        resolve(got);
      }
    });
    socket.on("error", reject);
    socket.on("close", () => resolve(finish()));
  });
}

function raw(path: string, headers: [string, string][], body: string, method = "POST"): Buffer {
  const all: [string, string][] = [["host", "127.0.0.1"], ...headers];
  const framed = all.some(([k]) => /^(content-length|transfer-encoding)$/i.test(k));
  if (!framed) all.push(["content-length", String(Buffer.byteLength(body))]);
  const head = `${method} ${path} HTTP/1.1\r\n${all.map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n`;
  return Buffer.concat([Buffer.from(head, "latin1"), Buffer.from(body)]);
}

// A short body under a longer Content-Length is a wait or a client gone on a
// real socket; the reader's own 400 is mutation-request.test.ts.

const failure = (status: number): { status: string; reason?: string } =>
  status === 401
    ? { status: "unauthenticated" }
    : status === 404
      ? { status: "not_found" }
      : { status: "unavailable", reason: "database_error" };
const byId = (list: readonly { assignmentId: string; submissions: AssignmentSubmission[] }[]) =>
  new Map(list.map((entry) => [entry.assignmentId, entry.submissions]));

type Case = {
  id: string;
  method: "GET" | "POST";
  path: (v: Vector) => string;
  arrange: (v: Vector) => void;
};
const CASES: Case[] = [
  {
    id: "teacher.courses.get",
    method: "GET",
    path: () => "/api/v1/teacher/courses",
    arrange: (v) => {
      if (v.response.status === 503) {
        courses = undefined;
        return;
      }
      courses =
        v.response.status === 200
          ? { ok: true, courses: v.response.body.courses as never }
          : { ok: false, reason: v.response.status === 404 ? "not_found" : "unauthenticated" };
    },
  },
  {
    id: "teacher.mentorships.get",
    method: "GET",
    path: () => "/api/v1/teacher/mentorships",
    arrange: (v) => {
      works =
        v.response.status === 200
          ? { status: "ok", works: v.response.body.works as never }
          : (failure(v.response.status) as MentoredWorksOutcome);
    },
  },
  {
    id: "teacher.mentorship.get",
    method: "GET",
    path: (v) => `/api/v1/teacher/mentorships/${v.request.params!.mentorshipId}`,
    arrange: (v) => {
      work =
        v.response.status === 200
          ? { status: "ok", work: v.response.body.work as never }
          : (failure(v.response.status) as MentoredWorkOutcome);
    },
  },
  {
    id: "teacher.submissions.get",
    method: "GET",
    path: (v) => `/api/v1/teacher/assignments/${v.request.params!.assignmentId}/submissions`,
    arrange: (v) => {
      const id = v.request.params!.assignmentId!.toLowerCase();
      submissions =
        v.response.status === 200
          ? { status: "ok", submissions: new Map([[id, v.response.body.submissions as never]]) }
          : (failure(v.response.status) as AssignmentSubmissionsOutcome);
    },
  },
  {
    id: "teacher.assignment-submissions.post",
    method: "POST",
    path: () => "/api/v1/teacher/assignment-submissions",
    arrange: (v) => {
      submissions =
        v.response.status === 200
          ? { status: "ok", submissions: byId(v.response.body.assignments as never) }
          : (failure(v.response.status) as AssignmentSubmissionsOutcome);
    },
  },
];
const UNREACHABLE = new Set(["content-length-mismatch", "body-stream-error"]);
/** A vector reaches the reader when it is answered from the reader's outcome. */
const REACHES = (v: Vector) =>
  [200, 404, 503].includes(v.response.status) ||
  (v.response.status === 401 && v.request.headers?.cookie !== undefined);

const cases = CASES.flatMap((c) =>
  vectorsOf(c.id)
    .filter((v) => !UNREACHABLE.has(v.name))
    .map((v) => [`${c.id} ${v.name}`, c, v] as const),
);

describe("every vector a socket can reach", () => {
  it.each(cases)("%s", async (_name, c, v) => {
    c.arrange(v);
    await start();
    const body = c.method === "GET" ? "" : (v.request.rawBody ?? JSON.stringify(v.request.body));
    const got = await send(raw(c.path(v), Object.entries(v.request.headers ?? {}), body, c.method));
    expect(got.status).toBe(v.response.status);
    if (v.name === "content-length-invalid") return; // Node's parser answers it itself.
    expect(got.head["content-type"]?.split(";")[0]).toBe("application/json");
    expect(got.head["cache-control"]).toBe("no-store");
    const json = JSON.parse(got.body) as Record<string, unknown>;
    if (got.status === 200) expect(json).toEqual(v.response.body);
    else expect(json).toEqual({ ...v.response.body, requestId: got.head["x-request-id"] });
    expect(calls).toHaveLength(REACHES(v) ? 1 : 0);
  });
});

describe("what reaches the readers", () => {
  const cookie = vectorsOf("teacher.courses.get")[0]!.request.headers!.cookie!;
  const token = cookie.slice("__Host-ductus_session=".length);
  const get = (path: string, headers: [string, string][] = [["cookie", cookie]]) =>
    send(raw(path, headers, "", "GET"));

  it("a mentorship id and an assignment id reach the reader decoded once", async () => {
    work = { status: "not_found" };
    submissions = { status: "ok", submissions: new Map() };
    await start();
    expect((await get("/api/v1/teacher/mentorships/%41bc")).status).toBe(404);
    const got = await get("/api/v1/teacher/assignments/nije-uuid/submissions");
    expect([got.status, JSON.parse(got.body)]).toEqual([200, { submissions: [] }]);
    expect(calls).toEqual([
      ["work", token, "Abc"],
      ["submissions", token, ["nije-uuid"]],
    ]);
  });

  it("an upper-case assignment id answers the reader's lower-case entry", async () => {
    const id = "3a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c01";
    const row = {
      studentId: id,
      documentId: null,
      submitted: false,
      revision: null,
      requestedMinute: null,
      afterDeadline: null,
    };
    submissions = { status: "ok", submissions: new Map([[id, [row]]]) };
    await start();
    const got = await get(`/api/v1/teacher/assignments/${id.toUpperCase()}/submissions`);
    expect(JSON.parse(got.body)).toEqual({ submissions: [row] });
  });

  it("two Sec-Fetch-Site values or a missing cookie never reach a reader", async () => {
    courses = { ok: true, courses: [] };
    await start();
    const twice: [string, string][] = [
      ["cookie", cookie],
      ["sec-fetch-site", "same-origin"],
      ["sec-fetch-site", "same-origin"],
    ];
    expect((await get("/api/v1/teacher/courses", twice)).status).toBe(403);
    expect((await get("/api/v1/teacher/courses", [])).status).toBe(401);
    expect(
      (
        await get("/api/v1/teacher/courses", [
          ["cookie", cookie],
          ["sec-fetch-site", "same-origin"],
        ])
      ).status,
    ).toBe(200);
    expect(calls).toEqual([["courses", token]]);
  });

  it("a reader that throws is 503", async () => {
    await start();
    courses = undefined;
    expect((await get("/api/v1/teacher/courses")).status).toBe(503);
  });
});

describe("parseAssignmentIdsBody", () => {
  const id = "3a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c01";
  it("takes 0 to 500 UUIDs in any case, duplicates counted", () => {
    expect(parseAssignmentIdsBody({ assignmentIds: [] })).toEqual([]);
    expect(parseAssignmentIdsBody({ assignmentIds: [id, id.toUpperCase(), id] })).toEqual([
      id,
      id.toUpperCase(),
      id,
    ]);
    expect(parseAssignmentIdsBody({ assignmentIds: Array(500).fill(id) })).toHaveLength(500);
  });
  it.each<[string, unknown]>([
    ["501 ids", { assignmentIds: Array(501).fill(id) }],
    ["a malformed id", { assignmentIds: [id, "nije-uuid"] }],
    ["a number", { assignmentIds: [1] }],
    ["an extra key", { assignmentIds: [], courseId: id }],
    ["no key", {}],
    ["an array", [id]],
    ["null", null],
    ["ids as text", { assignmentIds: id }],
  ])("refuses %s", (_name, value) => {
    expect(parseAssignmentIdsBody(value)).toBeNull();
  });
});

const reads: string[] = [];
const ACCESS = vectorsOf("teacher.access.get");
const pick = (list: Vector[], name: string) => list.find((v) => v.name === name)!;

const USER = "6e7f8091-a2b3-4c4d-9e5f-6a7b8c9d0e01";
const INSTITUTION = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c01";

function getAccess(
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port: server!.port, method: "GET", path, headers },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (text += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}
const tokenOf = (v: Vector) => v.request.headers!.cookie!.slice("__Host-ductus_session=".length);
const withoutRequestId = (body: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(body).filter(([k]) => k !== "requestId"));

describe("GET /api/v1/teacher/access", () => {
  const path = "/api/v1/teacher/access";

  it.each(["allowed", "denied"] as const)("answers %s with the principal's scope", async (name) => {
    const v = pick(ACCESS, name);
    access = async () => ({ ok: true, access: name, userId: USER, institutionId: INSTITUTION });
    await start();
    expect(await getAccess(path, v.request.headers)).toEqual({
      status: 200,
      body: { access: name, scope: principalScope(USER, INSTITUTION) },
    });
    expect(reads).toEqual([tokenOf(v)]);
  });

  it("401 when no live session is behind the cookie, 403 cross-site before any read", async () => {
    access = async () => ({ ok: false, reason: "unauthenticated" });
    await start();
    const cookie = pick(ACCESS, "allowed").request.headers!;
    const got = await getAccess(path, cookie);
    expect([got.status, withoutRequestId(got.body)]).toEqual([
      401,
      withoutRequestId(pick(ACCESS, "unauthorized").response.body),
    ]);
    reads.length = 0;
    expect((await getAccess(path, pick(ACCESS, "forbidden").request.headers)).status).toBe(403);
    expect(reads).toEqual([]);
  });

  it("503 when the read fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    access = async () => {
      throw new Error("down");
    };
    await start();
    const v = pick(ACCESS, "unavailable");
    expect((await getAccess(path, v.request.headers)).status).toBe(503);
  });
});

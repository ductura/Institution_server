// GET /api/v1/teacher/courses and GET /api/v1/teacher/access (SRV-13) on a
// real server with the real pipeline, over fake readers: every vector of both
// contracts, and no read without a well-formed same-origin session cookie.
// All values are invented.
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { TeacherAccessResult, TeacherCoursesResult } from "../database/index.ts";
import { principalScope } from "../session/index.ts";

import { createDatabases } from "./databases.ts";
import { createLayers } from "./pipeline.ts";
import { type Running, startServer } from "./start.ts";
import { createTeacherAccessRoute, createTeacherCoursesRoute } from "./teacher-reads.ts";

type Vector = {
  name: string;
  request: { headers?: Record<string, string> };
  response: { status: number; body: Record<string, unknown> };
};
const vectorsOf = (id: string): Vector[] =>
  (
    JSON.parse(
      readFileSync(new URL(`../contracts/vectors/${id}.json`, import.meta.url), "utf8"),
    ) as { vectors: Vector[] }
  ).vectors;
const COURSES = vectorsOf("teacher.courses.get");
const ACCESS = vectorsOf("teacher.access.get");
const pick = (list: Vector[], name: string) => list.find((v) => v.name === name)!;

const USER = "6e7f8091-a2b3-4c4d-9e5f-6a7b8c9d0e01";
const INSTITUTION = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c01";

let server: Running | undefined;
const reads: string[] = [];
let courses: () => Promise<TeacherCoursesResult>;
let access: () => Promise<TeacherAccessResult>;

async function start(): Promise<void> {
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    layers: createLayers({ expectedOrigin: "https://ductura.example.invalid" }),
    databases: createDatabases(),
    routes: [
      createTeacherCoursesRoute(async (token) => {
        reads.push(token);
        return courses();
      }),
      createTeacherAccessRoute(async (token) => {
        reads.push(token);
        return access();
      }),
    ],
  });
}
afterEach(async () => {
  reads.length = 0;
  vi.restoreAllMocks();
  await server?.close();
  server = undefined;
});

function get(
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

describe("GET /api/v1/teacher/courses", () => {
  const path = "/api/v1/teacher/courses";

  it.each(["courses", "no-courses"])("answers the %s vector", async (name) => {
    const v = pick(COURSES, name);
    courses = async () => ({ ok: true, courses: v.response.body.courses as never });
    await start();
    expect(await get(path, v.request.headers)).toEqual({ status: 200, body: v.response.body });
    expect(reads).toEqual([tokenOf(v)]);
  });

  it.each([
    ["unauthorized", { ok: false, reason: "unauthenticated" }],
    ["not-found", { ok: false, reason: "not_found" }],
  ] as const)("answers the %s vector", async (name, result) => {
    const v = pick(COURSES, name);
    courses = async () => result;
    await start();
    const cookie = pick(COURSES, "courses").request.headers!;
    const got = await get(path, name === "unauthorized" ? cookie : v.request.headers);
    expect([got.status, withoutRequestId(got.body)]).toEqual([
      v.response.status,
      withoutRequestId(v.response.body),
    ]);
  });

  it("401 without a cookie and 403 cross-site, before any read", async () => {
    courses = async () => ({ ok: true, courses: [] });
    await start();
    expect((await get(path)).status).toBe(401);
    const v = pick(COURSES, "forbidden");
    const got = await get(path, v.request.headers);
    expect([got.status, withoutRequestId(got.body)]).toEqual([
      403,
      withoutRequestId(v.response.body),
    ]);
    expect(reads).toEqual([]);
  });

  it("503 when the read fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    courses = async () => {
      throw new Error("down");
    };
    await start();
    const v = pick(COURSES, "unavailable");
    const got = await get(path, v.request.headers);
    expect([got.status, withoutRequestId(got.body)]).toEqual([
      503,
      withoutRequestId(v.response.body),
    ]);
  });
});

describe("GET /api/v1/teacher/access", () => {
  const path = "/api/v1/teacher/access";

  it.each(["allowed", "denied"] as const)("answers %s with the principal's scope", async (name) => {
    const v = pick(ACCESS, name);
    access = async () => ({ ok: true, access: name, userId: USER, institutionId: INSTITUTION });
    await start();
    expect(await get(path, v.request.headers)).toEqual({
      status: 200,
      body: { access: name, scope: principalScope(USER, INSTITUTION) },
    });
    expect(reads).toEqual([tokenOf(v)]);
  });

  it("401 when no live session is behind the cookie, 403 cross-site before any read", async () => {
    access = async () => ({ ok: false, reason: "unauthenticated" });
    await start();
    const cookie = pick(ACCESS, "allowed").request.headers!;
    const got = await get(path, cookie);
    expect([got.status, withoutRequestId(got.body)]).toEqual([
      401,
      withoutRequestId(pick(ACCESS, "unauthorized").response.body),
    ]);
    reads.length = 0;
    expect((await get(path, pick(ACCESS, "forbidden").request.headers)).status).toBe(403);
    expect(reads).toEqual([]);
  });

  it("503 when the read fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    access = async () => {
      throw new Error("down");
    };
    await start();
    const v = pick(ACCESS, "unavailable");
    expect((await get(path, v.request.headers)).status).toBe(503);
  });
});

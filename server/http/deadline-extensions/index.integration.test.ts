// GET and POST /api/v1/teacher/assignments/{assignmentId}/deadline-extensions
// (SRV-1108) on a real server with the real pipeline, over a fake port: the
// success and refusal vectors of the contract, the 404 of a malformed id
// before the port, and 503 for an answer the contract does not accept. The
// framing vectors (origin, size, stream) belong to the shared layers and are
// covered by their own tests. All values are invented.
import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import type { DeadlineExtensions } from "../../database/index.ts";
import { createDatabases, createLayers, type Running, startServer } from "../index.ts";

import { createDeadlineExtensionRoutes } from "./index.ts";

type Vector = {
  name: string;
  code?: string;
  request: {
    params: { assignmentId: string };
    headers?: Record<string, string>;
    body?: Record<string, unknown>;
    rawBody?: string;
  };
  response: { status: number; body: Record<string, unknown> };
};
const vectorsOf = (id: string): Vector[] =>
  (
    JSON.parse(
      readFileSync(new URL(`../../contracts/vectors/${id}.json`, import.meta.url), "utf8"),
    ) as { vectors: Vector[] }
  ).vectors;
const LIST = vectorsOf("teacher.deadline-extensions.get");
const ADD = vectorsOf("teacher.deadline-extension.post");
const ORIGIN = "https://ductura.example.invalid";
const A = "00000000-0000-4000-8000-0000000000a1";

let running: Running | undefined;
const calls: unknown[][] = [];
let list: () => Promise<unknown> = async () => ({ status: "read", extensions: [] });
let add: () => Promise<unknown> = async () => ({ status: "not_found" });

async function start(): Promise<string> {
  const port = {
    list: (...args: unknown[]) => (calls.push(["list", ...args]), list()),
    add: (...args: unknown[]) => (calls.push(["add", ...args]), add()),
  } as unknown as DeadlineExtensions;
  running = await startServer({
    host: "127.0.0.1",
    port: 0,
    databases: createDatabases(),
    layers: createLayers({ expectedOrigin: ORIGIN }),
    routes: createDeadlineExtensionRoutes(port),
  });
  return `http://127.0.0.1:${running.port}/api/v1/teacher/assignments`;
}

afterEach(async () => {
  calls.length = 0;
  list = async () => ({ status: "read", extensions: [] });
  add = async () => ({ status: "not_found" });
  await running?.close();
  running = undefined;
});

async function expectAnswer(got: Response, v: Vector) {
  expect(got.status).toBe(v.response.status);
  const body = (await got.json()) as Record<string, unknown>;
  if (v.response.status < 300) expect(body).toEqual(v.response.body);
  else expect(body).toEqual({ ...v.response.body, requestId: got.headers.get("x-request-id") });
}

describe("teacher.deadline-extensions.get", () => {
  it.each(LIST.map((v) => [v.name, v] as const))("vector %s", async (_name, v) => {
    list = async () =>
      v.response.status === 503
        ? Promise.reject(new Error("izmisljena greska"))
        : { status: "read", extensions: v.response.body.extensions };
    const base = await start();
    const got = await fetch(
      `${base}/${v.request.params.assignmentId}/deadline-extensions`,
      v.request.headers === undefined ? {} : { headers: v.request.headers },
    );
    await expectAnswer(got, v);
  });

  it("a refusal of the database reads 404", async () => {
    list = async () => ({ status: "not_found" });
    const base = await start();
    const got = await fetch(`${base}/${A}/deadline-extensions`, {
      headers: LIST[0]!.request.headers!,
    });
    expect(got.status).toBe(404);
  });
});

describe("teacher.deadline-extension.post", () => {
  const SHAPED = ADD.filter((v) =>
    [
      "one",
      "all",
      "unknown-reason",
      "all-reason-for-one",
      "one-without-student",
      "unknown-field",
      "not-found",
      "earlier-deadline",
      "unauthorized",
      "unavailable",
      "invalid-json",
      "unsupported-media-type",
    ].includes(v.name),
  );

  it.each(SHAPED.map((v) => [v.name, v] as const))("vector %s", async (_name, v) => {
    add = async () => {
      if (v.response.status === 201) return { status: "added", ...v.response.body };
      if (v.response.status === 503) throw new Error("izmisljena greska");
      if (v.code === "invalid_input") return { status: "invalid_input" };
      return { status: "not_found" };
    };
    const base = await start();
    const got = await fetch(`${base}/${v.request.params.assignmentId}/deadline-extensions`, {
      method: "POST",
      headers: v.request.headers ?? {},
      body: v.request.rawBody ?? JSON.stringify(v.request.body),
    });
    await expectAnswer(got, v);
  });

  it("sends the scope as a student id or null, in lower case", async () => {
    add = async () => ({ status: "not_found" });
    const base = await start();
    const one = ADD.find((v) => v.name === "one")!;
    const studentId = String(one.request.body!.studentId).toUpperCase();
    await fetch(`${base}/${A}/deadline-extensions`, {
      method: "POST",
      headers: one.request.headers ?? {},
      body: JSON.stringify({ ...one.request.body, studentId }),
    });
    const body = one.request.body!;
    expect(calls).toEqual([
      [
        "add",
        expect.any(String),
        {
          assignmentId: A,
          studentId: studentId.toLowerCase(),
          dueAt: body.dueAt,
          reasonId: body.reasonId,
        },
      ],
    ]);
  });

  it("an answer outside the contract is 503", async () => {
    add = async () => ({
      status: "added",
      extension: { id: "nije-uuid" },
      existingSubmissionsUnchanged: false,
    });
    const base = await start();
    const one = ADD.find((v) => v.name === "one")!;
    const got = await fetch(`${base}/${A}/deadline-extensions`, {
      method: "POST",
      headers: one.request.headers ?? {},
      body: JSON.stringify(one.request.body),
    });
    expect(got.status).toBe(503);
  });
});

// SRV-NF4-IZNIMKA-ZAPIS: the late-submission exception routes over a fake port.
describe("late-submission exception routes", () => {
  const LATE_LIST = vectorsOf("teacher.late-exceptions.get");
  const LATE_ADD = vectorsOf("teacher.late-exception.post");
  const OWN = vectorsOf("student.late-exceptions.get");
  let answer: () => Promise<unknown> = async () => ({ status: "not_found" });

  async function startLate(): Promise<string> {
    const port = {
      listLateExceptions: (...args: unknown[]) => (calls.push(["list", ...args]), answer()),
      grantLateException: (...args: unknown[]) => (calls.push(["grant", ...args]), answer()),
      listOwnLateExceptions: (...args: unknown[]) => (calls.push(["own", ...args]), answer()),
    } as unknown as DeadlineExtensions;
    running = await startServer({
      host: "127.0.0.1",
      port: 0,
      databases: createDatabases(),
      layers: createLayers({ expectedOrigin: ORIGIN }),
      routes: createDeadlineExtensionRoutes(port),
    });
    return `http://127.0.0.1:${running.port}/api/v1`;
  }
  afterEach(() => {
    answer = async () => ({ status: "not_found" });
  });

  const refusalOf = (v: Vector) => () =>
    v.response.status === 503
      ? Promise.reject(new Error("izmisljena greska"))
      : Promise.resolve(
          v.response.status === 401
            ? { status: "unauthorized" }
            : v.code === "invalid_input"
              ? { status: "invalid_input" }
              : { status: "not_found" },
        );

  it.each(LATE_LIST.map((v) => [v.name, v] as const))("teacher list vector %s", async (_n, v) => {
    answer = async () =>
      v.response.status === 200
        ? { status: "read", exceptions: v.response.body.exceptions }
        : refusalOf(v)();
    const base = await startLate();
    const got = await fetch(
      `${base}/teacher/assignments/${v.request.params.assignmentId}/late-submission-exceptions`,
      v.request.headers === undefined ? {} : { headers: v.request.headers },
    );
    await expectAnswer(got, v);
  });

  it.each(OWN.map((v) => [v.name, v] as const))("student own vector %s", async (_n, v) => {
    answer = async () =>
      v.response.status === 200
        ? { status: "read", exceptions: v.response.body.exceptions }
        : refusalOf(v)();
    const base = await startLate();
    const got = await fetch(
      `${base}/student/assignments/${v.request.params.assignmentId}/late-submission-exceptions`,
      v.request.headers === undefined ? {} : { headers: v.request.headers },
    );
    await expectAnswer(got, v);
  });

  const SHAPED = LATE_ADD.filter((v) =>
    [
      "grant",
      "reason-all-refused",
      "one-without-student",
      "unknown-reason",
      "unknown-field",
      "not-found",
      "not-later",
      "unauthorized",
      "unavailable",
      "invalid-json",
      "unsupported-media-type",
    ].includes(v.name),
  );
  it.each(SHAPED.map((v) => [v.name, v] as const))("grant vector %s", async (_n, v) => {
    answer = async () =>
      v.response.status === 201
        ? { status: "granted", exception: v.response.body.exception }
        : refusalOf(v)();
    const base = await startLate();
    const got = await fetch(
      `${base}/teacher/assignments/${v.request.params.assignmentId}/late-submission-exceptions`,
      {
        method: "POST",
        headers: v.request.headers ?? {},
        body: v.request.rawBody ?? JSON.stringify(v.request.body),
      },
    );
    await expectAnswer(got, v);
  });

  it("a malformed assignment id is 404 before the port, on all three routes", async () => {
    const base = await startLate();
    const headers = LATE_LIST[0]!.request.headers!;
    for (const role of ["teacher", "student"]) {
      const got = await fetch(`${base}/${role}/assignments/nije-uuid/late-submission-exceptions`, {
        headers,
      });
      expect(got.status).toBe(404);
    }
    const post = LATE_ADD.find((v) => v.name === "grant")!;
    const got = await fetch(`${base}/teacher/assignments/nije-uuid/late-submission-exceptions`, {
      method: "POST",
      headers: post.request.headers ?? {},
      body: JSON.stringify(post.request.body),
    });
    expect(got.status).toBe(404);
    expect(calls).toEqual([]);
  });

  it("sends the ids in lower case and nothing but what the contract names", async () => {
    const base = await startLate();
    const grant = LATE_ADD.find((v) => v.name === "grant")!;
    const studentId = String(grant.request.body!.studentId).toUpperCase();
    await fetch(`${base}/teacher/assignments/${A.toUpperCase()}/late-submission-exceptions`, {
      method: "POST",
      headers: grant.request.headers ?? {},
      body: JSON.stringify({ ...grant.request.body, studentId }),
    });
    const body = grant.request.body!;
    expect(calls).toEqual([
      [
        "grant",
        expect.any(String),
        {
          assignmentId: A,
          studentId: studentId.toLowerCase(),
          untilAt: body.untilAt,
          reasonId: body.reasonId,
        },
      ],
    ]);
  });

  it("an answer outside the contract is 503", async () => {
    answer = async () => ({ status: "granted", exception: { id: "nije-uuid" } });
    const base = await startLate();
    const grant = LATE_ADD.find((v) => v.name === "grant")!;
    const got = await fetch(`${base}/teacher/assignments/${A}/late-submission-exceptions`, {
      method: "POST",
      headers: grant.request.headers ?? {},
      body: JSON.stringify(grant.request.body),
    });
    expect(got.status).toBe(503);
  });
});

// GET and POST /api/v1/teacher/assignments/{assignmentId}/deadline-extensions
// (SRV-1108) on a real server with the real pipeline, over a fake port: the
// success and refusal vectors of the contract, the 404 of a malformed id
// before the port, and 503 for an answer the contract does not accept. The
// framing vectors (origin, size, stream) belong to the shared layers and are
// covered by their own tests. All values are invented.
import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import type { DeadlineExtensions } from "../../database/index.ts";
import { createDatabases } from "../databases.ts";
import { createLayers } from "../pipeline.ts";
import { type Running, startServer } from "../start.ts";

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

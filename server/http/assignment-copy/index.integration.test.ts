// POST /api/v1/teacher/assignments/{assignmentId}/copy (SRV-1904) on a real
// server with the real pipeline, over a fake port: the success and refusal
// vectors of the contract, the 404 of a malformed id before the port, the
// ids sent in lower case and 503 for an answer the contract does not accept.
// The framing vectors (origin, size, stream) belong to the shared layers and
// are covered by their own tests. All values are invented.
import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import type { AssignmentCopy } from "../../database/index.ts";
import { createDatabases, createLayers, type Running, startServer } from "../index.ts";

import { createAssignmentCopyRoute } from "./index.ts";

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
const VECTORS = (
  JSON.parse(
    readFileSync(
      new URL("../../contracts/vectors/teacher.assignment-copy.post.json", import.meta.url),
      "utf8",
    ),
  ) as { vectors: Vector[] }
).vectors;
const ORIGIN = "https://ductura.example.invalid";
const A = "00000000-0000-4000-8000-0000000000a1";
const COPY = VECTORS.find((v) => v.name === "copy")!;

let running: Running | undefined;
const calls: unknown[][] = [];
let copy: () => Promise<unknown> = async () => ({ status: "not_found" });

async function start(): Promise<string> {
  const port = {
    copy: (...args: unknown[]) => (calls.push(args), copy()),
  } as unknown as AssignmentCopy;
  running = await startServer({
    host: "127.0.0.1",
    port: 0,
    databases: createDatabases(),
    layers: createLayers({ expectedOrigin: ORIGIN }),
    routes: [createAssignmentCopyRoute(port)],
  });
  return `http://127.0.0.1:${running.port}/api/v1/teacher/assignments`;
}

afterEach(async () => {
  calls.length = 0;
  copy = async () => ({ status: "not_found" });
  await running?.close();
  running = undefined;
});

async function post(base: string, assignmentId: string, v: Vector, body?: unknown) {
  return fetch(`${base}/${assignmentId}/copy`, {
    method: "POST",
    headers: v.request.headers ?? {},
    body:
      body === undefined
        ? (v.request.rawBody ?? JSON.stringify(v.request.body))
        : JSON.stringify(body),
  });
}

describe("teacher.assignment-copy.post", () => {
  const SHAPED = VECTORS.filter((v) =>
    [
      "copy",
      "copy-new-dates",
      "opening-after-deadline",
      "without-course",
      "unknown-field",
      "not-found",
      "course-not-taught",
      "conflict",
      "unauthorized",
      "unavailable",
      "invalid-json",
      "unsupported-media-type",
    ].includes(v.name),
  );

  it.each(SHAPED.map((v) => [v.name, v] as const))("vector %s", async (_name, v) => {
    copy = async () => {
      if (v.response.status === 201) return { status: "copied", id: v.response.body.id };
      if (v.response.status === 503) throw new Error("izmisljena greska");
      if (v.code === "invalid_input") return { status: "invalid_input" };
      if (v.code === "conflict") return { status: "conflict" };
      return { status: "not_found" };
    };
    const base = await start();
    const got = await post(base, v.request.params.assignmentId, v);
    expect(got.status).toBe(v.response.status);
    const body = (await got.json()) as Record<string, unknown>;
    if (v.response.status < 300) {
      expect(body).toEqual(v.response.body);
      expect(got.headers.get("cache-control")).toBe("no-store");
    } else {
      expect(body).toEqual({ ...v.response.body, requestId: got.headers.get("x-request-id") });
    }
  });

  it("sends the ids in lower case and absent dates as null", async () => {
    const base = await start();
    const body = COPY.request.body!;
    await post(base, A.toUpperCase(), COPY, {
      requestKey: String(body.requestKey).toUpperCase(),
      courseId: String(body.courseId).toUpperCase(),
    });
    expect(calls).toEqual([
      [
        expect.any(String),
        {
          assignmentId: A,
          courseId: body.courseId,
          requestKey: body.requestKey,
          opensAt: null,
          dueAt: null,
        },
      ],
    ]);
  });

  it("answers a malformed assignment id 404 before the port", async () => {
    const base = await start();
    const got = await post(base, "nije-uuid", COPY);
    expect(got.status).toBe(404);
    expect(calls).toEqual([]);
  });

  it("an unauthenticated port answer reads 401", async () => {
    copy = async () => ({ status: "unauthorized" });
    const base = await start();
    expect((await post(base, A, COPY)).status).toBe(401);
  });

  it("an answer outside the contract is 503", async () => {
    copy = async () => ({ status: "copied", id: "nije-uuid" });
    const base = await start();
    expect((await post(base, A, COPY)).status).toBe(503);
  });
});

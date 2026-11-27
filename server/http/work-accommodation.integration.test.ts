// The accommodation mark (F4-PM2-R08-SRV) on a real server with the real
// pipeline, over a fake port: the success and refusal vectors of the three
// contracts, a body that is not exactly {marked} refused before the port, the
// port never asked for a malformed id, and 503 for an answer outside the
// contract. The framing vectors (origin, size, stream) belong to the shared
// layers and are covered by their own tests. All values are invented.
import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { createDatabases, createLayers, type Running, startServer } from "./index.ts";
import { createWorkAccommodationRoutes, type WorkAccommodationPort } from "./work-accommodation.ts";

type Vector = {
  name: string;
  request: {
    params: Record<string, string>;
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
const FRAMING = new Set([
  "origin-missing",
  "origin-mismatch",
  "cross-site",
  "body-too-large",
  "body-timeout",
  "content-length-invalid",
  "content-length-mismatch",
  "body-stream-error",
]);
const studentPath = (p: Record<string, string>) =>
  `/student/assignments/${p.assignmentId}/accommodation`;
const ROUTES = [
  { id: "student.accommodation.get", method: "GET", path: studentPath },
  { id: "student.accommodation.put", method: "PUT", path: studentPath },
  {
    id: "teacher.student-accommodation.get",
    method: "GET",
    path: (p: Record<string, string>) =>
      `/teacher/assignments/${p.assignmentId}/students/${p.studentId}/accommodation`,
  },
] as const;

let running: Running | undefined;
const calls: unknown[][] = [];
let reply: () => Promise<unknown> = async () => ({ kind: "notFound" });

async function start(): Promise<string> {
  const port = {
    readOwn: (...args: unknown[]) => (calls.push(["readOwn", ...args]), reply()),
    read: (...args: unknown[]) => (calls.push(["read", ...args]), reply()),
    set: (...args: unknown[]) => (calls.push(["set", ...args]), reply()),
  } as unknown as WorkAccommodationPort;
  running = await startServer({
    host: "127.0.0.1",
    port: 0,
    databases: createDatabases(),
    layers: createLayers({ expectedOrigin: ORIGIN }),
    routes: createWorkAccommodationRoutes(port),
  });
  return `http://127.0.0.1:${running.port}/api/v1`;
}

afterEach(async () => {
  calls.length = 0;
  reply = async () => ({ kind: "notFound" });
  await running?.close();
  running = undefined;
});

function portAnswer(v: Vector): unknown {
  const { status, body } = v.response;
  if (status === 200) return { kind: "ok", ...body };
  if (status === 401) return { kind: "unauthorized" };
  if (status === 403) return { kind: "forbidden" };
  if (status === 404) return { kind: "notFound" };
  if (status === 409) return { kind: "conflict" };
  return { kind: "unavailable" };
}

describe.each(ROUTES.map((r) => [r.id, r] as const))("%s", (id, route) => {
  const vectors = vectorsOf(id).filter((v) => !FRAMING.has(v.name));
  it.each(vectors.map((v) => [v.name, v] as const))("vector %s", async (_name, v) => {
    reply = async () => portAnswer(v);
    const base = await start();
    const got = await fetch(base + route.path(v.request.params), {
      method: route.method,
      headers: v.request.headers ?? {},
      ...(v.request.rawBody !== undefined || v.request.body !== undefined
        ? { body: v.request.rawBody ?? JSON.stringify(v.request.body) }
        : {}),
    });
    expect(got.status).toBe(v.response.status);
    const body = (await got.json()) as Record<string, unknown>;
    if (v.response.status < 300) expect(body).toEqual(v.response.body);
    else expect(body).toEqual({ ...v.response.body, requestId: got.headers.get("x-request-id") });
  });
});

describe("the mark", () => {
  const TOKEN = "izmisljeni-token-studenta-00000000000000001";
  const student = {
    cookie: `__Host-ductus_session=${TOKEN}`,
    origin: ORIGIN,
    "sec-fetch-site": "same-origin",
    "content-type": "application/json",
  };
  const ID = "00000000-0000-4000-8000-0000000000a1";
  const STUDENT = "5e4d3c2b-1a09-4f8e-8d7c-6b5a4f3e2d01";
  const put = (base: string, assignment: string, body: string) =>
    fetch(`${base}/student/assignments/${assignment}/accommodation`, {
      method: "PUT",
      headers: student,
      body,
    });

  it("each port call gets only the token and the ids from the path, in lower case", async () => {
    reply = async () => ({ kind: "ok", marked: true });
    const base = await start();
    await put(base, ID.toUpperCase(), '{"marked":true}');
    await fetch(`${base}/student/assignments/${ID}/accommodation`, { headers: student });
    await fetch(
      `${base}/teacher/assignments/${ID}/students/${STUDENT.toUpperCase()}/accommodation`,
      {
        headers: student,
      },
    );
    expect(calls).toEqual([
      ["set", TOKEN, ID, true],
      ["readOwn", TOKEN, ID],
      ["read", TOKEN, ID, STUDENT],
    ]);
  });

  it.each([
    ["a text value", '{"marked":"da"}'],
    ["a reason", '{"marked":true,"reason":"x"}'],
    ["no value", "{}"],
  ])("a body with %s is 422 and the port is not asked", async (_name, body) => {
    const base = await start();
    expect((await put(base, ID, body)).status).toBe(422);
    expect(calls).toEqual([]);
  });

  it("a malformed id is refused without the port", async () => {
    const base = await start();
    expect((await put(base, "nije-uuid", '{"marked":true}')).status).toBe(403);
    expect(
      (await fetch(`${base}/student/assignments/nije-uuid/accommodation`, { headers: student }))
        .status,
    ).toBe(404);
    expect(
      (
        await fetch(`${base}/teacher/assignments/${ID}/students/nije-uuid/accommodation`, {
          headers: student,
        })
      ).status,
    ).toBe(404);
    expect(calls).toEqual([]);
  });

  it("an answer outside the contract is 503, never sent", async () => {
    reply = async () => ({ kind: "ok", marked: "da" });
    const base = await start();
    const got = await fetch(`${base}/student/assignments/${ID}/accommodation`, {
      headers: student,
    });
    expect(got.status).toBe(503);
  });
});

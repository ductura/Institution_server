// Whether a late submission is allowed (SRV-NF4-KASNA-POLJE) on a real server
// with the real pipeline, over a fake port: the success and refusal vectors of
// both contracts, a body that is not exactly {lateSubmissionAllowed} refused
// before the port, the port never asked for a malformed id, another's
// assignment read as 404 on both routes, and 503 for an answer outside the
// contract. The framing vectors (origin, size, stream) belong to the shared
// layers and are covered by their own tests. All values are invented.
import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import type { LateSubmissionPort } from "../database/index.ts";

import { createDatabases, createLayers, type Running, startServer } from "./index.ts";
import { createLateSubmissionRoutes } from "./late-submission.ts";

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
const ROUTES = [
  { id: "institution.assignment-late-submission.put", method: "PUT", scope: "institution" },
  { id: "student.assignment-late-submission.get", method: "GET", scope: "student" },
] as const;
const path = (scope: string, assignmentId: string) =>
  `/${scope}/assignments/${assignmentId}/late-submission`;

let running: Running | undefined;
const calls: unknown[][] = [];
let reply: () => Promise<unknown> = async () => ({ status: "not_found" });

async function start(): Promise<string> {
  const port = {
    read: (...args: unknown[]) => (calls.push(["read", ...args]), reply()),
    set: (...args: unknown[]) => (calls.push(["set", ...args]), reply()),
  } as unknown as LateSubmissionPort;
  running = await startServer({
    host: "127.0.0.1",
    port: 0,
    databases: createDatabases(),
    layers: createLayers({ expectedOrigin: ORIGIN }),
    routes: createLateSubmissionRoutes(port),
  });
  return `http://127.0.0.1:${running.port}/api/v1`;
}

afterEach(async () => {
  calls.length = 0;
  reply = async () => ({ status: "not_found" });
  await running?.close();
  running = undefined;
});

function portAnswer(v: Vector): unknown {
  const { status, body } = v.response;
  if (status === 200) return { status: "read", ...body };
  if (status === 401) return { status: "unauthorized" };
  if (status === 404) return { status: "not_found" };
  if (status === 422) return { status: "invalid_input" };
  throw new Error("izmišljen kvar baze");
}

describe.each(ROUTES.map((r) => [r.id, r] as const))("%s", (id, route) => {
  const vectors = vectorsOf(id).filter((v) => !FRAMING.has(v.name));
  it.each(vectors.map((v) => [v.name, v] as const))("vector %s", async (_name, v) => {
    reply = async () => portAnswer(v);
    const base = await start();
    const got = await fetch(base + path(route.scope, v.request.params.assignmentId!), {
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

const ID = "00000000-0000-4000-8000-0000000000a1";
const TEACHER = {
  cookie: "__Host-ductus_session=izmisljeni-token-nastavnika-000000000000001",
  origin: ORIGIN,
  "sec-fetch-site": "same-origin",
  "content-type": "application/json",
};
const STUDENT = { cookie: "__Host-ductus_session=izmisljeni-token-predaje-000000000000000000" };
const put = (base: string, assignment: string, body: string) =>
  fetch(base + path("institution", assignment), { method: "PUT", headers: TEACHER, body });
const get = (base: string, assignment: string, headers: Record<string, string> = STUDENT) =>
  fetch(base + path("student", assignment), { headers });

describe("the teacher sets it", () => {
  it("the port gets the token, the assignment in lowercase and the value", async () => {
    reply = async () => ({ status: "read", lateSubmissionAllowed: false });
    const base = await start();
    const got = await put(base, ID.toUpperCase(), '{"lateSubmissionAllowed":false}');
    expect(await got.json()).toEqual({ lateSubmissionAllowed: false });
    expect(got.headers.get("cache-control")).toBe("no-store");
    expect(calls).toEqual([["set", "izmisljeni-token-nastavnika-000000000000001", ID, false]]);
  });

  it.each([
    ["a text value", '{"lateSubmissionAllowed":"da"}'],
    ["a null value", '{"lateSubmissionAllowed":null}'],
    ["another field", '{"lateSubmissionAllowed":true,"by":"nastavnik"}'],
    ["no value", "{}"],
  ])("a body with %s is 422 and the port is not asked", async (_name, body) => {
    const base = await start();
    expect((await put(base, ID, body)).status).toBe(422);
    expect(calls).toEqual([]);
  });

  it("a malformed id is 404 without the port", async () => {
    const base = await start();
    expect((await put(base, "nije-uuid", '{"lateSubmissionAllowed":true}')).status).toBe(404);
    expect(calls).toEqual([]);
  });

  it("another teacher's, a student's or an unknown assignment is 404, the same answer", async () => {
    const base = await start();
    const got = await put(base, ID, '{"lateSubmissionAllowed":false}');
    expect(got.status).toBe(404);
    expect(((await got.json()) as { code: string }).code).toBe("not_found");
  });

  it("an answer outside the contract is 503, never sent", async () => {
    reply = async () => ({ status: "read", lateSubmissionAllowed: "da" });
    const base = await start();
    expect((await put(base, ID, '{"lateSubmissionAllowed":true}')).status).toBe(503);
  });
});

describe("a student of the course reads it", () => {
  it("the port gets the token and the assignment in lowercase", async () => {
    reply = async () => ({ status: "read", lateSubmissionAllowed: true });
    const base = await start();
    const got = await get(base, ID.toUpperCase());
    expect(await got.json()).toEqual({ lateSubmissionAllowed: true });
    expect(got.headers.get("cache-control")).toBe("no-store");
    expect(calls).toEqual([["read", "izmisljeni-token-predaje-000000000000000000", ID]]);
  });

  it("an assignment outside the student's courses is 404", async () => {
    const base = await start();
    const got = await get(base, ID);
    expect(got.status).toBe(404);
    expect(((await got.json()) as { code: string }).code).toBe("not_found");
  });

  it("a cross-site read is refused without the port", async () => {
    const base = await start();
    const got = await get(base, ID, { ...STUDENT, "sec-fetch-site": "cross-site" });
    expect(got.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it("a failing port is 503", async () => {
    reply = async () => {
      throw new Error("izmišljen kvar baze");
    };
    const base = await start();
    expect((await get(base, ID)).status).toBe(503);
  });
});

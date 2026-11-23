// The teacher's declaration requirement (PIL-K-IZJAVA-SRV, declaration-v1
// §6.7) on a real server with the real pipeline, over a fake port: the success
// and refusal vectors of the contracts, a body other than {required} refused
// before the port, a malformed id never reaching it, and 503 for an answer
// outside the contract. The framing vectors (origin, size, stream) belong to
// the shared layers and are covered by their own tests. All values are invented.
import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import type { DeclarationRequirement } from "../../database/index.ts";
import { createDatabases, createLayers, type Running, startServer } from "../index.ts";

import { createDeclarationRequirementRoutes } from "./index.ts";

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
      readFileSync(new URL(`../../contracts/vectors/${id}.json`, import.meta.url), "utf8"),
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
  { id: "teacher.declaration-requirement.get", method: "GET", call: "read" },
  { id: "teacher.declaration-requirement.put", method: "PUT", call: "set" },
] as const;
const pathOf = (assignmentId: string) =>
  `/teacher/assignments/${assignmentId}/declaration-requirement`;

let running: Running | undefined;
const calls: unknown[][] = [];
let reply: () => Promise<unknown> = async () => ({ status: "not_found" });

async function start(): Promise<string> {
  const port = Object.fromEntries(
    ["read", "set"].map((name) => [
      name,
      (...args: unknown[]) => (calls.push([name, ...args]), reply()),
    ]),
  ) as unknown as DeclarationRequirement;
  running = await startServer({
    host: "127.0.0.1",
    port: 0,
    databases: createDatabases(),
    layers: createLayers({ expectedOrigin: ORIGIN }),
    routes: createDeclarationRequirementRoutes(port),
  });
  return `http://127.0.0.1:${running.port}/api/v1`;
}

afterEach(async () => {
  calls.length = 0;
  reply = async () => ({ status: "not_found" });
  await running?.close();
  running = undefined;
});

const send = (base: string, method: string, path: string, v: Vector["request"]) =>
  fetch(base + path, {
    method,
    headers: v.headers ?? {},
    ...(v.rawBody !== undefined || v.body !== undefined
      ? { body: v.rawBody ?? JSON.stringify(v.body) }
      : {}),
  });

function portAnswer(v: Vector): unknown {
  const { status, body } = v.response;
  if (status === 200) return { status: "ok", ...body };
  if (status === 401) return { status: "unauthenticated" };
  if (status === 404) return { status: "not_found" };
  if (status === 422) return { status: "invalid" };
  return { status: "unavailable" };
}

describe.each(ROUTES.map((r) => [r.id, r] as const))("%s", (id, route) => {
  const vectors = vectorsOf(id).filter((v) => !FRAMING.has(v.name));
  it.each(vectors.map((v) => [v.name, v] as const))("vector %s", async (_name, v) => {
    reply = async () => portAnswer(v);
    const base = await start();
    const got = await send(base, route.method, pathOf(v.request.params.assignmentId!), v.request);
    expect(got.status).toBe(v.response.status);
    const body = (await got.json()) as Record<string, unknown>;
    if (v.response.status < 300) expect(body).toEqual(v.response.body);
    else expect(body).toEqual({ ...v.response.body, requestId: got.headers.get("x-request-id") });
  });
});

describe("the teacher's declaration requirement", () => {
  const teacher = {
    cookie: "__Host-ductus_session=izmisljeni-token-nastavnika-000000000000001",
    origin: ORIGIN,
    "sec-fetch-site": "same-origin",
    "content-type": "application/json",
  };
  const ASSIGNMENT = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

  it("passes the token, the assignment and the value to the port", async () => {
    reply = async () => ({ status: "ok", required: true, changedAt: "2026-11-23T10:00:00.000Z" });
    const base = await start();
    const got = await fetch(base + pathOf(ASSIGNMENT), {
      method: "PUT",
      headers: teacher,
      body: JSON.stringify({ required: true }),
    });
    expect(await got.json()).toEqual({ required: true, changedAt: "2026-11-23T10:00:00.000Z" });
    expect(calls).toEqual([
      ["set", "izmisljeni-token-nastavnika-000000000000001", ASSIGNMENT, true],
    ]);
  });

  it.each([
    ["an extra field", { required: true, reason: "x" }],
    ["a text value", { required: "true" }],
    ["no value", {}],
    ["a null", { required: null }],
  ])("a body with %s is 422 and the port is not asked", async (_name, body) => {
    const base = await start();
    const got = await fetch(base + pathOf(ASSIGNMENT), {
      method: "PUT",
      headers: teacher,
      body: JSON.stringify(body),
    });
    expect(got.status).toBe(422);
    expect(calls).toEqual([]);
  });

  it("a malformed id never reaches the port", async () => {
    const base = await start();
    expect((await fetch(base + pathOf("nije-uuid"), { headers: teacher })).status).toBe(404);
    expect(calls).toEqual([]);
  });

  it.each([
    ["a text for the switch", { status: "ok", required: "da", changedAt: null }],
    ["a time without milliseconds", { status: "ok", required: true, changedAt: "2026-11-23" }],
  ])("an answer with %s is 503, never sent", async (_name, answer) => {
    reply = async () => answer;
    const base = await start();
    expect((await fetch(base + pathOf(ASSIGNMENT), { headers: teacher })).status).toBe(503);
  });
});

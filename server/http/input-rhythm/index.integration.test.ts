// The rhythm of typing (PIL-P1-RITAM-SRV, P-1 rule 4) on a real server with the
// real pipeline, over a fake port: the success and refusal vectors of the
// contracts, a body with a key refused before the port, the port never asked
// for a malformed id, and 503 for an answer that holds a key or a derived
// speed. The framing vectors (origin, size, stream) belong to the shared layers
// and are covered by their own tests. All values are invented.
import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import type { InputRhythm } from "../../database/index.ts";
import { createDatabases, createLayers, type Running, startServer } from "../index.ts";

import { createInputRhythmRoutes } from "./index.ts";

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
  {
    id: "work.input-rhythm.post",
    method: "POST",
    call: "record",
    path: (p: Record<string, string>) => `/works/${p.documentId}/input-rhythm`,
  },
  {
    id: "work.input-rhythm.get",
    method: "GET",
    call: "read",
    path: (p: Record<string, string>) => `/works/${p.documentId}/input-rhythm`,
  },
  {
    id: "work.input-rhythm.delete",
    method: "DELETE",
    call: "remove",
    path: (p: Record<string, string>) => `/works/${p.documentId}/input-rhythm`,
  },
  {
    id: "work.input-rhythm-setting.get",
    method: "GET",
    call: "state",
    path: (p: Record<string, string>) => `/works/${p.documentId}/input-rhythm/setting`,
  },
  {
    id: "teacher.input-rhythm.get",
    method: "GET",
    call: "readEnabled",
    path: (p: Record<string, string>) => `/teacher/assignments/${p.assignmentId}/input-rhythm`,
  },
  {
    id: "teacher.input-rhythm.put",
    method: "PUT",
    call: "setEnabled",
    path: (p: Record<string, string>) => `/teacher/assignments/${p.assignmentId}/input-rhythm`,
  },
] as const;

let running: Running | undefined;
const calls: unknown[][] = [];
let reply: () => Promise<unknown> = async () => ({ status: "not_found" });

async function start(): Promise<string> {
  const port = Object.fromEntries(
    ["record", "read", "remove", "state", "readEnabled", "setEnabled"].map((name) => [
      name,
      (...args: unknown[]) => (calls.push([name, ...args]), reply()),
    ]),
  ) as unknown as InputRhythm;
  running = await startServer({
    host: "127.0.0.1",
    port: 0,
    databases: createDatabases(),
    layers: createLayers({ expectedOrigin: ORIGIN }),
    routes: createInputRhythmRoutes(port),
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
    const got = await send(base, route.method, route.path(v.request.params), v.request);
    expect(got.status).toBe(v.response.status);
    const body = (await got.json()) as Record<string, unknown>;
    if (v.response.status < 300) expect(body).toEqual(v.response.body);
    else expect(body).toEqual({ ...v.response.body, requestId: got.headers.get("x-request-id") });
  });
});

describe("no key and no derived measure leaves the server", () => {
  const student = {
    cookie: "__Host-ductus_session=izmisljeni-token-rada-000000000000000000001",
    origin: ORIGIN,
    "sec-fetch-site": "same-origin",
    "content-type": "application/json",
  };
  const burst = {
    id: "6a5b4c3d-2e1f-4a0b-9c8d-7e6f5a4b3c51",
    gapsMs: [120],
    recordedAt: "2026-11-22T10:00:00.000Z",
  };

  it.each([
    ["a key in the burst", { status: "ok", bursts: [{ ...burst, key: "a" }] }],
    ["a key code in the burst", { status: "ok", bursts: [{ ...burst, keyCode: 65 }] }],
    ["a speed in the burst", { status: "ok", bursts: [{ ...burst, speedWpm: 41 }] }],
    ["a gap with a fraction", { status: "ok", bursts: [{ ...burst, gapsMs: [12.5] }] }],
  ])("%s is 503, never sent", async (_name, answer) => {
    reply = async () => answer;
    const base = await start();
    const got = await fetch(`${base}/works/izmisljeni-rad-0001/input-rhythm`, { headers: student });
    expect(got.status).toBe(503);
    const text = await got.text();
    expect(text).not.toMatch(/"key|speed|wpm/i);
  });

  it.each([
    ["a key", { gapsMs: [120], key: "a" }],
    ["a key code", { gapsMs: [120], keyCode: 65 }],
    ["131 gaps", { gapsMs: Array(131).fill(9) }],
    ["no gaps", { gapsMs: [] }],
    ["a negative gap", { gapsMs: [-1] }],
    ["a gap over an hour", { gapsMs: [3_600_001] }],
    ["a gap with a fraction", { gapsMs: [1.5] }],
  ])("a body with %s is 422 and the port is not asked", async (_name, body) => {
    const base = await start();
    const got = await fetch(`${base}/works/izmisljeni-rad-0001/input-rhythm`, {
      method: "POST",
      headers: student,
      body: JSON.stringify(body),
    });
    expect(got.status).toBe(422);
    expect(calls).toEqual([]);
  });

  it("the switched-off recording answers that nothing was saved", async () => {
    reply = async () => ({ status: "ok", recorded: false });
    const base = await start();
    const got = await fetch(`${base}/works/izmisljeni-rad-0001/input-rhythm`, {
      method: "POST",
      headers: student,
      body: JSON.stringify({ gapsMs: [120, 80] }),
    });
    expect(await got.json()).toEqual({ recorded: false });
    expect(calls).toEqual([
      ["record", "izmisljeni-token-rada-000000000000000000001", "izmisljeni-rad-0001", [120, 80]],
    ]);
  });

  it("a student's switch is a 404 like any other refusal, and a malformed id never reaches the port", async () => {
    reply = async () => ({ status: "not_found" });
    const base = await start();
    const put = (assignment: string) =>
      fetch(`${base}/teacher/assignments/${assignment}/input-rhythm`, {
        method: "PUT",
        headers: student,
        body: JSON.stringify({ enabled: false }),
      });
    expect((await put("0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d")).status).toBe(404);
    expect(calls).toHaveLength(1);
    expect((await put("nije-uuid")).status).toBe(404);
    expect(calls).toHaveLength(1);
  });
});

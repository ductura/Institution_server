// The teacher's declaration question (SRV-IZJAVA-PITANJE) on a real server with
// the real pipeline, over a fake port: the success and refusal vectors of the
// contracts, a body that is not exactly {question} refused before the port,
// the port never asked for a malformed id, and 503 for an answer outside the
// contract. The framing vectors (origin, size, stream) belong to the shared
// layers and are covered by their own tests. All values are invented.
import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import type { DeclarationQuestionPort } from "../database/index.ts";

import { createDeclarationQuestionRoutes } from "./declaration-question.ts";
import { createDatabases, createLayers, type Running, startServer } from "./index.ts";

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
  { id: "teacher.declaration-question.get", method: "GET", call: "read" },
  { id: "teacher.declaration-question.put", method: "PUT", call: "set" },
] as const;
const path = (p: Record<string, string>) =>
  `/teacher/assignments/${p.assignmentId}/declaration-question`;

let running: Running | undefined;
const calls: unknown[][] = [];
let reply: () => Promise<unknown> = async () => ({ status: "not_found" });

async function start(): Promise<string> {
  const port = {
    read: (...args: unknown[]) => (calls.push(["read", ...args]), reply()),
    set: (...args: unknown[]) => (calls.push(["set", ...args]), reply()),
  } as unknown as DeclarationQuestionPort;
  running = await startServer({
    host: "127.0.0.1",
    port: 0,
    databases: createDatabases(),
    layers: createLayers({ expectedOrigin: ORIGIN }),
    routes: createDeclarationQuestionRoutes(port),
  });
  return `http://127.0.0.1:${running.port}/api/v1`;
}

afterEach(async () => {
  calls.length = 0;
  reply = async () => ({ status: "not_found" });
  await running?.close();
  running = undefined;
});

const send = (base: string, method: string, v: Vector["request"]) =>
  fetch(base + path(v.params), {
    method,
    headers: v.headers ?? {},
    ...(v.rawBody !== undefined || v.body !== undefined
      ? { body: v.rawBody ?? JSON.stringify(v.body) }
      : {}),
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
    const got = await send(base, route.method, v.request);
    expect(got.status).toBe(v.response.status);
    const body = (await got.json()) as Record<string, unknown>;
    if (v.response.status < 300) expect(body).toEqual(v.response.body);
    else expect(body).toEqual({ ...v.response.body, requestId: got.headers.get("x-request-id") });
  });
});

describe("the teacher's question", () => {
  const teacher = {
    cookie: "__Host-ductus_session=izmisljeni-token-nastavnika-000000000000001",
    origin: ORIGIN,
    "sec-fetch-site": "same-origin",
    "content-type": "application/json",
  };
  const ID = "00000000-0000-4000-8000-0000000000a1";
  const put = (base: string, assignment: string, body: string) =>
    fetch(`${base}/teacher/assignments/${assignment}/declaration-question`, {
      method: "PUT",
      headers: teacher,
      body,
    });

  it("the port gets the token, the assignment and the question", async () => {
    reply = async () => ({
      status: "read",
      question: "Izmišljeno pitanje?",
      changedAt: "2026-11-23T10:00:00.000Z",
    });
    const base = await start();
    const got = await put(base, ID, '{"question":"Izmišljeno pitanje?"}');
    expect(await got.json()).toEqual({
      question: "Izmišljeno pitanje?",
      changedAt: "2026-11-23T10:00:00.000Z",
    });
    expect(calls).toEqual([
      ["set", "izmisljeni-token-nastavnika-000000000000001", ID, "Izmišljeno pitanje?"],
    ]);
  });

  it("null removes the question", async () => {
    reply = async () => ({ status: "read", question: null, changedAt: "2026-11-23T10:00:00.000Z" });
    const base = await start();
    expect((await put(base, ID, '{"question":null}')).status).toBe(200);
    expect(calls).toEqual([["set", "izmisljeni-token-nastavnika-000000000000001", ID, null]]);
  });

  it.each([
    ["a boolean value", '{"question":true}'],
    ["another field", '{"question":"Pitanje?","by":"nastavnik"}'],
    ["no value", "{}"],
    ["an empty question", '{"question":""}'],
    ["a leading space", '{"question":" Pitanje?"}'],
    ["a control character", '{"question":"Pi\\u0007tanje?"}'],
    ["501 code points", JSON.stringify({ question: "ž".repeat(501) })],
  ])("a body with %s is 422 and the port is not asked", async (_name, body) => {
    const base = await start();
    expect((await put(base, ID, body)).status).toBe(422);
    expect(calls).toEqual([]);
  });

  it("a malformed id is 404 without the port", async () => {
    const base = await start();
    expect((await put(base, "nije-uuid", '{"question":null}')).status).toBe(404);
    expect(calls).toEqual([]);
  });

  it("an answer outside the contract is 503, never sent", async () => {
    reply = async () => ({ status: "read", question: 7, changedAt: null });
    const base = await start();
    const got = await fetch(`${base}/teacher/assignments/${ID}/declaration-question`, {
      headers: teacher,
    });
    expect(got.status).toBe(503);
  });
});

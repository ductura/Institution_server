// The record of a restore (INT-21 C) on a real server with the real pipeline,
// over a fake port: the success and refusal vectors of the contract, a body
// that names more than the revision refused before the port, the port never
// asked for a malformed id, and 503 for an answer outside the contract. The
// framing vectors (origin, size, stream) belong to the shared layers and are
// covered by their own tests. All values are invented.
import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { RESTORE_MAX_FROM_REVISION } from "../../contracts/index.ts";
import { RESTORE_MAX_FROM, type RevisionRestore } from "../../database/index.ts";
import { createDatabases, createLayers, type Running, startServer } from "../index.ts";

import { createRevisionRestoreRoute } from "./index.ts";

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
const VECTORS = (
  JSON.parse(
    readFileSync(
      new URL("../../contracts/vectors/work.restore.post.json", import.meta.url),
      "utf8",
    ),
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
const STUDENT = {
  cookie: "__Host-ductus_session=izmisljeni-token-rada-000000000000000000001",
  origin: ORIGIN,
  "sec-fetch-site": "same-origin",
  "content-type": "application/json",
};

let running: Running | undefined;
const calls: unknown[][] = [];
let reply: () => Promise<unknown> = async () => ({ status: "not_found" });

async function start(): Promise<string> {
  const record = ((...args: unknown[]) => (calls.push(args), reply())) as RevisionRestore;
  running = await startServer({
    host: "127.0.0.1",
    port: 0,
    databases: createDatabases(),
    layers: createLayers({ expectedOrigin: ORIGIN }),
    routes: [createRevisionRestoreRoute(record)],
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
  if (status === 200) return { status: "ok", ...body };
  if (status === 401) return { status: "unauthenticated" };
  if (status === 404) return { status: "not_found" };
  if (status === 422) return { status: "invalid" };
  return { status: "unavailable" };
}

const post = (
  base: string,
  documentId: string,
  init: { headers?: Record<string, string>; body?: string },
) => fetch(`${base}/works/${documentId}/restores`, { method: "POST", ...init });

describe("work.restore.post", () => {
  const vectors = VECTORS.filter((v) => !FRAMING.has(v.name));
  it.each(vectors.map((v) => [v.name, v] as const))("vector %s", async (_name, v) => {
    reply = async () => portAnswer(v);
    const base = await start();
    const got = await post(base, v.request.params.documentId!, {
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

  it("asks the port once with the session, the work and the revision", async () => {
    reply = async () => ({ status: "ok", outcome: "recorded", revision: 4 });
    const base = await start();
    const got = await post(base, "izmisljeni-rad-0001", {
      headers: STUDENT,
      body: JSON.stringify({ fromRevision: 2 }),
    });
    expect(await got.json()).toEqual({ outcome: "recorded", revision: 4 });
    expect(calls).toEqual([
      ["izmisljeni-token-rada-000000000000000000001", "izmisljeni-rad-0001", 2],
    ]);
  });

  it.each([
    ["a revision the client claims for itself", { fromRevision: 1, revision: 3 }],
    ["revision 0", { fromRevision: 0 }],
    ["a revision past the bound", { fromRevision: 9_007_199_254_740_991 }],
    ["a fraction", { fromRevision: 1.5 }],
    ["a revision as text", { fromRevision: "1" }],
    ["no revision", {}],
  ])("a body with %s is 422 and the port is not asked", async (_name, body) => {
    const base = await start();
    const got = await post(base, "izmisljeni-rad-0001", {
      headers: STUDENT,
      body: JSON.stringify(body),
    });
    expect(got.status).toBe(422);
    expect(calls).toEqual([]);
  });

  it.each([
    ["an unknown outcome", { status: "ok", outcome: "restored", revision: 3 }],
    ["recorded without a revision", { status: "ok", outcome: "recorded" }],
    ["already_recorded without a revision", { status: "ok", outcome: "already_recorded" }],
    ["no match with a revision", { status: "ok", outcome: "no_matching_revision", revision: 3 }],
    ["the revision restored from", { status: "ok", outcome: "recorded", revision: 1 }],
    ["a revision before it", { status: "ok", outcome: "already_recorded", revision: 0 }],
    ["a revision as text", { status: "ok", outcome: "recorded", revision: "3" }],
  ])("%s is 503, never sent", async (_name, answer) => {
    reply = async () => answer;
    const base = await start();
    const got = await post(base, "izmisljeni-rad-0001", {
      headers: STUDENT,
      body: JSON.stringify({ fromRevision: 1 }),
    });
    expect(got.status).toBe(503);
    expect(await got.text()).not.toMatch(/restored"|"revision/);
  });

  it("a malformed work id is 404 and never reaches the port", async () => {
    const base = await start();
    const got = await post(base, "%20nije-rad", {
      headers: STUDENT,
      body: JSON.stringify({ fromRevision: 1 }),
    });
    expect(got.status).toBe(404);
    expect(calls).toEqual([]);
  });
});

describe("the bound of a restore", () => {
  it("the port and the contract refuse the same revisions", () => {
    expect(RESTORE_MAX_FROM).toBe(RESTORE_MAX_FROM_REVISION);
  });
});

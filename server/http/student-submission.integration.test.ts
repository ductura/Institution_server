// GET /api/v1/student/assignments/{assignmentId}/submission and .../requirements
// (SRV-22) on a real server with the real pipeline, over a fake port: every
// contract vector, the 404 of a malformed id before the port, the 403 of a
// cross-site fetch, and 503 for an answer the contract does not accept. The
// rows over real PostgreSQL are tests/db/submission-route.integration.test.ts.
// All values are invented.
import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import {
  MY_SUBMISSION_STATE_DATABASE_ERROR,
  type MySubmissionStateReader,
  type StoredSubmissionState,
  type StoredWordRange,
} from "../database/index.ts";

import { createDatabases } from "./databases.ts";
import { createLayers } from "./pipeline.ts";
import { type Running, startServer } from "./start.ts";
import { createStudentSubmissionRoutes } from "./student-submission.ts";

type Vector = {
  name: string;
  request: { params: { assignmentId: string }; headers?: Record<string, string> };
  response: { status: number; body: Record<string, unknown> };
};
const vectorsOf = (id: string): Vector[] =>
  (
    JSON.parse(
      readFileSync(new URL(`../contracts/vectors/${id}.json`, import.meta.url), "utf8"),
    ) as { vectors: Vector[] }
  ).vectors;
const SUBMISSION = vectorsOf("student.submission.get");
const REQUIREMENTS = vectorsOf("student.assignment-requirements.get");
const A = "00000000-0000-4000-8000-0000000000a1";
const COOKIE = SUBMISSION[0]!.request.headers!.cookie!;
const TOKEN = COOKIE.split("=")[1];

let running: Running | undefined;
const calls: unknown[][] = [];
let state: () => Promise<unknown> = async () => ({ ok: true, value: { state: "none" } });
let requirements: () => Promise<unknown> = async () => ({
  ok: true,
  value: { wordMin: null, wordMax: null },
});

async function start(): Promise<string> {
  const reader = {
    state: (...args: unknown[]) => (calls.push(["state", ...args]), state()),
    requirements: (...args: unknown[]) => (calls.push(["requirements", ...args]), requirements()),
  } as MySubmissionStateReader;
  running = await startServer({
    host: "127.0.0.1",
    port: 0,
    databases: createDatabases(),
    layers: createLayers({ expectedOrigin: "https://ductura.example.invalid" }),
    routes: createStudentSubmissionRoutes(reader),
  });
  return `http://127.0.0.1:${running.port}/api/v1/student/assignments`;
}

afterEach(async () => {
  calls.length = 0;
  state = async () => ({ ok: true, value: { state: "none" } });
  await running?.close();
  running = undefined;
});

/** JCS of the flat payload: its ASCII keys sorted (http may not import domain). */
const jcsOf = (payload: object): string =>
  JSON.stringify(Object.fromEntries(Object.entries(payload).sort(([a], [b]) => (a < b ? -1 : 1))));

/** The stored row a 200 vector stands for. */
function storedOf(body: Record<string, unknown>): StoredSubmissionState {
  if (body.state !== "potvrdeno") return body as StoredSubmissionState;
  const receipt = body.receipt as { payload: { revision: number }; payloadDigestSha256: string };
  return {
    state: "potvrdeno",
    revision: receipt.payload.revision,
    receiptPayload: jcsOf(receipt.payload),
    payloadDigestSha256: receipt.payloadDigestSha256,
    signature: (body.receipt as { signature: unknown }).signature,
  };
}

function rangeOf(body: Record<string, unknown>): StoredWordRange {
  const range = body.wordRange as { min: number | null; max: number | null } | null;
  return { wordMin: range?.min ?? null, wordMax: range?.max ?? null };
}

async function expectVector(url: string, v: Vector, read: "state" | "requirements") {
  const got = await fetch(
    url,
    v.request.headers === undefined ? {} : { headers: v.request.headers },
  );
  expect(got.status).toBe(v.response.status);
  expect(got.headers.get("content-type")).toMatch(/^application\/json\b/u);
  expect(got.headers.get("cache-control")).toBe("no-store");
  expect(got.headers.get("set-cookie")).toBeNull();
  const text = await got.text();
  if (v.response.body.state === "potvrdeno") {
    // The payload goes out in its stored JCS order, as the submission sends it.
    expect(JSON.parse(text)).toEqual(v.response.body);
  } else if (v.response.status === 200) {
    expect(text).toBe(JSON.stringify(v.response.body));
  } else {
    expect(JSON.parse(text)).toEqual({
      ...v.response.body,
      requestId: got.headers.get("x-request-id"),
    });
  }
  const reached = v.response.status === 200 || v.response.status === 503;
  expect(calls).toEqual(reached ? [[read, TOKEN, A]] : []);
}

describe("student.submission.get", () => {
  it.each(SUBMISSION.map((v) => [v.name, v] as const))("vector %s", async (_name, v) => {
    state = async () =>
      v.response.status === 503
        ? { ok: false, error: MY_SUBMISSION_STATE_DATABASE_ERROR }
        : { ok: true, value: storedOf(v.response.body) };
    const base = await start();
    await expectVector(`${base}/${v.request.params.assignmentId}/submission`, v, "state");
  });

  it("reads an upper-case uuid as its lower-case form", async () => {
    const base = await start();
    const got = await fetch(`${base}/${A.toUpperCase()}/submission`, {
      headers: { cookie: COOKIE },
    });
    expect(got.status).toBe(200);
    expect(calls).toEqual([["state", TOKEN, A]]);
  });

  it("a malformed id is 404 before the port, the same body as another's assignment", async () => {
    const base = await start();
    for (const id of ["nije-uuid", `${A}x`, encodeURIComponent(` ${A}`)]) {
      const got = await fetch(`${base}/${id}/submission`, { headers: { cookie: COOKIE } });
      expect(got.status).toBe(404);
    }
    expect(calls).toEqual([]);
  });

  it("a cross-site fetch is 403 before the session", async () => {
    const base = await start();
    const got = await fetch(`${base}/${A}/submission`, {
      headers: { cookie: COOKIE, "sec-fetch-site": "cross-site" },
    });
    expect(got.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it("an answer outside the contract, or a throw, is 503", async () => {
    for (const answer of [
      async () => ({ ok: true, value: { state: "ceka", revision: 0, requestedAt: "jucer" } }),
      () => Promise.reject(new Error("izmisljena greska")),
    ]) {
      state = answer;
      const base = await start();
      const got = await fetch(`${base}/${A}/submission`, { headers: { cookie: COOKIE } });
      expect(got.status).toBe(503);
      await running?.close();
      running = undefined;
    }
  });
});

describe("student.assignment-requirements.get", () => {
  it.each(REQUIREMENTS.map((v) => [v.name, v] as const))("vector %s", async (_name, v) => {
    requirements = async () =>
      v.response.status === 503
        ? { ok: false, error: MY_SUBMISSION_STATE_DATABASE_ERROR }
        : { ok: true, value: rangeOf(v.response.body) };
    const base = await start();
    await expectVector(`${base}/${v.request.params.assignmentId}/requirements`, v, "requirements");
  });

  it("a range the contract does not accept is 503", async () => {
    requirements = async () => ({ ok: true, value: { wordMin: 0, wordMax: null } });
    const base = await start();
    const got = await fetch(`${base}/${A}/requirements`, { headers: { cookie: COOKIE } });
    expect(got.status).toBe(503);
  });
});

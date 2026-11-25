// GET /api/v1/student/assignments/{assignmentId}/assistant-conversations
// (SRV-ASIST-CITANJE) on a real server with the real pipeline, over a fake
// port: every contract vector, 404 for another's or an unknown assignment and
// for a malformed id before the port, and 503 for an answer the contract does
// not accept. All values are invented.
import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import {
  STUDENT_CONVERSATIONS_DATABASE_ERROR,
  STUDENT_CONVERSATIONS_NOT_FOUND,
  type StudentConversationsReader,
} from "../database/index.ts";

import { createDatabases } from "./databases.ts";
import { createLayers } from "./pipeline.ts";
import { type Running, startServer } from "./start.ts";
import { createStudentConversationsRoute } from "./student-assistant-conversations.ts";

type Vector = {
  name: string;
  request: { params: { assignmentId: string }; headers?: Record<string, string> };
  response: { status: number; body: Record<string, unknown> };
};
const VECTORS = (
  JSON.parse(
    readFileSync(
      new URL("../contracts/vectors/student.assistant-conversations.get.json", import.meta.url),
      "utf8",
    ),
  ) as { vectors: Vector[] }
).vectors;
const A = VECTORS[0]!.request.params.assignmentId;
const COOKIE = VECTORS[0]!.request.headers!.cookie!;
const TOKEN = COOKIE.split("=")[1];
const OTHER = "9e000000-0000-4000-8000-000000000009";

let running: Running | undefined;
const calls: unknown[][] = [];
let answer: () => Promise<unknown> = async () => ({
  ok: false,
  error: STUDENT_CONVERSATIONS_NOT_FOUND,
});

async function start(): Promise<string> {
  const reader = {
    read: (...args: unknown[]) => (calls.push(args), answer()),
  } as StudentConversationsReader;
  running = await startServer({
    host: "127.0.0.1",
    port: 0,
    databases: createDatabases(),
    layers: createLayers({ expectedOrigin: "https://ductura.example.invalid" }),
    routes: [createStudentConversationsRoute(reader)],
  });
  return `http://127.0.0.1:${running.port}/api/v1/student/assignments`;
}

afterEach(async () => {
  calls.length = 0;
  answer = async () => ({ ok: false, error: STUDENT_CONVERSATIONS_NOT_FOUND });
  await running?.close();
  running = undefined;
});

describe("student.assistant-conversations.get", () => {
  it.each(VECTORS.map((v) => [v.name, v] as const))("vector %s", async (_name, v) => {
    answer = async () =>
      v.response.status === 200
        ? { ok: true, value: v.response.body.conversations }
        : v.response.status === 503
          ? { ok: false, error: STUDENT_CONVERSATIONS_DATABASE_ERROR }
          : { ok: false, error: STUDENT_CONVERSATIONS_NOT_FOUND };
    const base = await start();
    const got = await fetch(
      `${base}/${v.request.params.assignmentId}/assistant-conversations`,
      v.request.headers === undefined ? {} : { headers: v.request.headers },
    );
    expect(got.status).toBe(v.response.status);
    expect(got.headers.get("cache-control")).toBe("no-store");
    const body = (await got.json()) as Record<string, unknown>;
    if (v.response.status === 200) expect(body).toEqual(v.response.body);
    else expect(body).toEqual({ ...v.response.body, requestId: got.headers.get("x-request-id") });
    const reached = [200, 404, 503].includes(v.response.status);
    expect(calls).toEqual(reached ? [[TOKEN, v.request.params.assignmentId.toLowerCase()]] : []);
  });

  it("another student's or an unknown assignment is 404, the same as a malformed id", async () => {
    const base = await start();
    const got = await fetch(`${base}/${OTHER}/assistant-conversations`, {
      headers: { cookie: COOKIE },
    });
    expect(got.status).toBe(404);
    expect(calls).toEqual([[TOKEN, OTHER]]);
    calls.length = 0;
    expect(
      (await fetch(`${base}/nije-uuid/assistant-conversations`, { headers: { cookie: COOKIE } }))
        .status,
    ).toBe(404);
    expect(calls).toEqual([]);
    await fetch(`${base}/${A.toUpperCase()}/assistant-conversations`, {
      headers: { cookie: COOKIE },
    });
    expect(calls).toEqual([[TOKEN, A]]);
  });

  it("an answer outside the contract, or a throw, is 503", async () => {
    const first = (VECTORS[0]!.response.body.conversations as object[])[0]!;
    for (const bad of [
      async () => ({ ok: true, value: [{ ...first, requestCount: 0 }] }),
      async () => ({ ok: true, value: [{ ...first, text: "izmisljeni tekst" }] }),
      () => Promise.reject(new Error("izmisljena greska")),
    ]) {
      answer = bad;
      const base = await start();
      expect(
        (await fetch(`${base}/${A}/assistant-conversations`, { headers: { cookie: COOKIE } }))
          .status,
      ).toBe(503);
      await running?.close();
      running = undefined;
    }
  });
});

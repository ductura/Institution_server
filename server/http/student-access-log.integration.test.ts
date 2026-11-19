// GET /api/v1/student/works/{documentId}/access-log (SRV-11) on a real server
// with the real pipeline and router, over a fake reader: every vector of
// student.access-log.get, and the cursor rules of the contract (exactly one
// beforeAt and beforeId, not in the future, a refused cursor reads the first
// page with continued false). All values are invented.
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import type { AccessLogCursor, AccessLogEntry, MyAccessLogReader } from "../database/index.ts";

import { createDatabases } from "./databases.ts";
import { createLayers } from "./pipeline.ts";
import { type Running, startServer } from "./start.ts";
import { createStudentAccessLogRoute } from "./student-access-log.ts";

type Vector = {
  name: string;
  request: {
    headers?: Record<string, string>;
    params: { documentId: string };
    query?: Record<string, string>;
  };
  response: { status: number; body: Record<string, unknown> };
};
const VECTORS = (
  JSON.parse(
    readFileSync(
      new URL("../contracts/vectors/student.access-log.get.json", import.meta.url),
      "utf8",
    ),
  ) as { vectors: Vector[] }
).vectors;
const vector = (name: string) => VECTORS.find((v) => v.name === name)!;
const NOW = Date.parse("2026-11-19T12:00:00.000Z");
const COOKIE = vector("first-page").request.headers!;

type Result = Awaited<ReturnType<MyAccessLogReader["read"]>>;
type Call = { token: string | undefined; documentId: string; cursor: AccessLogCursor | null };
const calls: Call[] = [];
let server: Running | undefined;

const fail = (code: string): Result => ({
  ok: false,
  error: { code, messageKey: "x" },
});
/** The reader's page that the vector's body is the contract form of. */
function pageOf(body: Record<string, unknown>): Result {
  const entries = (body.entries as (Omit<AccessLogEntry, "at"> & { at: string })[]).map((e) => ({
    ...e,
    at: Date.parse(e.at),
  }));
  return { ok: true, value: { entries, next: body.next as AccessLogCursor | null } };
}

async function start(answer: (call: Call) => Result | Promise<never>) {
  const reader: MyAccessLogReader = {
    async read(token, documentId, cursor) {
      const call = { token, documentId, cursor: cursor ?? null };
      calls.push(call);
      return answer(call);
    },
  };
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    layers: createLayers({ expectedOrigin: "https://ductura.example.invalid" }),
    databases: createDatabases(),
    routes: [createStudentAccessLogRoute(reader, () => NOW)],
  });
}
afterEach(async () => {
  calls.length = 0;
  await server?.close();
  server = undefined;
});

function get(path: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port: server!.port, method: "GET", path, headers },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (text += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}
const pathOf = (v: Vector) =>
  `/api/v1/student/works/${encodeURIComponent(v.request.params.documentId)}/access-log` +
  (v.request.query ? `?${new URLSearchParams(v.request.query)}` : "");
const withoutRequestId = ({ requestId: _, ...rest }: Record<string, unknown>) => rest;

describe("GET /api/v1/student/works/{documentId}/access-log", () => {
  it.each(["first-page", "continued", "cursor-ignored"])("answers the %s vector", async (name) => {
    const v = vector(name);
    await start(() => pageOf(v.response.body));
    const got = await get(pathOf(v), v.request.headers);
    expect(got).toEqual({ status: 200, body: v.response.body });
    const cursor = name === "continued" ? (v.request.query as AccessLogCursor) : null;
    expect(calls).toEqual([
      { token: COOKIE.cookie!.split("=")[1], documentId: "izmisljeni-rad-0001", cursor },
    ]);
  });

  it.each([
    ["not-found-or-not-the-owner", () => fail("MY_ACCESS_LOG_NOT_FOUND")],
    ["unavailable", () => fail("MY_ACCESS_LOG_ROW_MALFORMED")],
    ["unavailable", () => Promise.reject(new Error("izmišljeni kvar"))],
  ] as const)("answers the %s vector", async (name, answer) => {
    const v = vector(name);
    await start(answer);
    const got = await get(pathOf(v), v.request.headers);
    expect(got.status).toBe(v.response.status);
    expect(withoutRequestId(got.body)).toEqual(withoutRequestId(v.response.body));
  });

  it.each(["unauthorized", "forbidden"])("answers %s without reading", async (name) => {
    const v = vector(name);
    await start(() => pageOf(vector("first-page").response.body));
    const got = await get(pathOf(v), v.request.headers);
    expect(withoutRequestId(got.body)).toEqual(withoutRequestId(v.response.body));
    expect(calls).toEqual([]);
  });

  it("answers 401 when the reader finds no session behind a well-formed cookie", async () => {
    await start(() => fail("MY_ACCESS_LOG_UNAUTHENTICATED"));
    expect((await get(pathOf(vector("first-page")), COOKIE)).status).toBe(401);
  });

  it("reads the first page for a future, a doubled or a half cursor, and for one the reader refuses", async () => {
    const first = vector("first-page").response.body;
    await start((call) =>
      call.cursor?.beforeId === "nije-uuid" ? fail("MY_ACCESS_LOG_CURSOR_INVALID") : pageOf(first),
    );
    const base = "/api/v1/student/works/izmisljeni-rad-0001/access-log";
    const id = "6a5b4c3d-2e1f-4a0b-9c8d-7e6f5a4b3c03";
    for (const query of [
      `beforeAt=2026-11-19T12:05:00.000Z&beforeId=${id}`,
      `beforeAt=2026-11-09T19:55:00.000Z&beforeAt=2026-11-09T19:50:00.000Z&beforeId=${id}`,
      `beforeId=${id}`,
      "beforeAt=2026-11-09T19:55:00.000Z&beforeId=nije-uuid",
    ]) {
      const got = await get(`${base}?${query}`, COOKIE);
      expect(got).toEqual({ status: 200, body: { ...first, continued: false } });
      expect(calls.at(-1)!.cursor).toBeNull();
    }
  });

  it("answers 404 without reading for a path segment that is no work id", async () => {
    await start(() => pageOf(vector("first-page").response.body));
    const got = await get("/api/v1/student/works/%00/access-log", COOKIE);
    expect(got.status).toBe(404);
    expect(calls).toEqual([]);
  });
});

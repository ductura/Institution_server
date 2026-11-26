// GET /api/v1/student/assignments/{assignmentId}/notice (SRV-NG) on a real
// server with the real pipeline, over a fake port: every contract vector, the
// 404 of a malformed id before the port and 503 for an answer the contract
// does not accept. All values are invented.
import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import {
  STUDENT_NOTICE_DATABASE_ERROR,
  STUDENT_NOTICE_NOT_FOUND,
  type StoredNotice,
  type StudentNoticeReader,
} from "../database/index.ts";

import { createDatabases } from "./databases.ts";
import { createLayers } from "./pipeline.ts";
import { type Running, startServer } from "./start.ts";
import { createStudentNoticeRoute } from "./student-notice.ts";

type Vector = {
  name: string;
  request: { params: { assignmentId: string }; headers?: Record<string, string> };
  response: { status: number; body: Record<string, unknown> };
};
const VECTORS = (
  JSON.parse(
    readFileSync(new URL("../contracts/vectors/student.notice.get.json", import.meta.url), "utf8"),
  ) as { vectors: Vector[] }
).vectors;
const A = VECTORS[0]!.request.params.assignmentId;
const COOKIE = VECTORS[0]!.request.headers!.cookie!;
const TOKEN = COOKIE.split("=")[1];

let running: Running | undefined;
const calls: unknown[][] = [];
let answer: () => Promise<unknown> = async () => ({ ok: false, error: STUDENT_NOTICE_NOT_FOUND });

async function start(): Promise<string> {
  const reader = {
    read: (...args: unknown[]) => (calls.push(args), answer()),
  } as StudentNoticeReader;
  running = await startServer({
    host: "127.0.0.1",
    port: 0,
    databases: createDatabases(),
    layers: createLayers({ expectedOrigin: "https://ductura.example.invalid" }),
    routes: [createStudentNoticeRoute(reader)],
  });
  return `http://127.0.0.1:${running.port}/api/v1/student/assignments`;
}

afterEach(async () => {
  calls.length = 0;
  answer = async () => ({ ok: false, error: STUDENT_NOTICE_NOT_FOUND });
  await running?.close();
  running = undefined;
});

function storedOf(body: Record<string, unknown>): StoredNotice {
  const rest: Record<string, unknown> = { ...body };
  delete rest.templateVersion;
  return rest as StoredNotice;
}

describe("student.notice.get", () => {
  it.each(VECTORS.map((v) => [v.name, v] as const))("vector %s", async (_name, v) => {
    answer = async () =>
      v.response.status === 200
        ? { ok: true, value: storedOf(v.response.body) }
        : v.response.status === 503
          ? { ok: false, error: STUDENT_NOTICE_DATABASE_ERROR }
          : { ok: false, error: STUDENT_NOTICE_NOT_FOUND };
    const base = await start();
    const got = await fetch(
      `${base}/${v.request.params.assignmentId}/notice`,
      v.request.headers === undefined ? {} : { headers: v.request.headers },
    );
    expect(got.status).toBe(v.response.status);
    expect(got.headers.get("cache-control")).toBe("no-store");
    const body = (await got.json()) as Record<string, unknown>;
    if (v.response.status === 200) expect(body).toEqual(v.response.body);
    else expect(body).toEqual({ ...v.response.body, requestId: got.headers.get("x-request-id") });
    const reached = [200, 404, 503].includes(v.response.status);
    expect(calls).toEqual(reached ? [[TOKEN, A]] : []);
  });

  it("a malformed id is 404 before the port; an upper-case uuid is read in lower case", async () => {
    const base = await start();
    expect((await fetch(`${base}/nije-uuid/notice`, { headers: { cookie: COOKIE } })).status).toBe(
      404,
    );
    expect(calls).toEqual([]);
    await fetch(`${base}/${A.toUpperCase()}/notice`, { headers: { cookie: COOKIE } });
    expect(calls).toEqual([[TOKEN, A]]);
  });

  it("an answer outside the contract, or a throw, is 503", async () => {
    for (const bad of [
      async () => ({ ok: true, value: { ...storedOf(VECTORS[0]!.response.body), versionNo: 0 } }),
      async () => ({
        ok: true,
        value: { ...storedOf(VECTORS[0]!.response.body), aiSummaryOnly: "true" },
      }),
      () => Promise.reject(new Error("izmisljena greska")),
    ]) {
      answer = bad;
      const base = await start();
      expect((await fetch(`${base}/${A}/notice`, { headers: { cookie: COOKIE } })).status).toBe(
        503,
      );
      await running?.close();
      running = undefined;
    }
  });
});

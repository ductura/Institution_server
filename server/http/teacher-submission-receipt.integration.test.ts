// GET /api/v1/teacher/assignments/{assignmentId}/students/{studentId}/submission
// (SRV-30) on a real server with the real pipeline, over a fake port: every
// contract vector, the 404 of a refusal and of a malformed id before the port,
// the 403 of a cross-site fetch, 503 for an answer the contract does not
// accept, and the same receipt bytes the student's read answers (PRODUCT §5
// rule 5). All values are invented.
import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import {
  MY_SUBMISSION_STATE_DATABASE_ERROR,
  MY_SUBMISSION_STATE_NOT_FOUND,
  type MySubmissionStateReader,
  type StoredSubmissionState,
} from "../database/index.ts";

import { createDatabases } from "./databases.ts";
import { createLayers } from "./pipeline.ts";
import { type Running, startServer } from "./start.ts";
import { createStudentSubmissionRoutes } from "./student-submission.ts";
import { createTeacherSubmissionReceiptRoute } from "./teacher-submission-receipt.ts";

type Vector = {
  name: string;
  request: {
    params: { assignmentId: string; studentId?: string };
    headers?: Record<string, string>;
  };
  response: { status: number; body: Record<string, unknown> };
};
const vectorsOf = (id: string): Vector[] =>
  (
    JSON.parse(
      readFileSync(new URL(`../contracts/vectors/${id}.json`, import.meta.url), "utf8"),
    ) as { vectors: Vector[] }
  ).vectors;
const TEACHER = vectorsOf("teacher.submission-receipt.get");
const STUDENT = vectorsOf("student.submission.get");
const A = "00000000-0000-4000-8000-0000000000a1";
const S = "00000000-0000-4000-8000-0000000000e1";
const COOKIE = TEACHER[0]!.request.headers!.cookie!;
const TOKEN = COOKIE.split("=")[1];

let running: Running | undefined;
const calls: unknown[][] = [];
let stored: () => Promise<unknown> = async () => ({ ok: true, value: { state: "none" } });

async function start(): Promise<string> {
  const reader = {
    state: (...args: unknown[]) => (calls.push(["state", ...args]), stored()),
    requirements: () => Promise.reject(new Error("not this read")),
    teacherState: (...args: unknown[]) => (calls.push(["teacherState", ...args]), stored()),
  } as MySubmissionStateReader;
  running = await startServer({
    host: "127.0.0.1",
    port: 0,
    databases: createDatabases(),
    layers: createLayers({ expectedOrigin: "https://ductura.example.invalid" }),
    routes: [...createStudentSubmissionRoutes(reader), createTeacherSubmissionReceiptRoute(reader)],
  });
  return `http://127.0.0.1:${running.port}/api/v1`;
}

afterEach(async () => {
  calls.length = 0;
  stored = async () => ({ ok: true, value: { state: "none" } });
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

const urlOf = (base: string, a: string, s: string) =>
  `${base}/teacher/assignments/${a}/students/${s}/submission`;

describe("teacher.submission-receipt.get", () => {
  it.each(TEACHER.map((v) => [v.name, v] as const))("vector %s", async (_name, v) => {
    stored = async () =>
      v.response.status === 503
        ? { ok: false, error: MY_SUBMISSION_STATE_DATABASE_ERROR }
        : { ok: true, value: storedOf(v.response.body) };
    const base = await start();
    const { assignmentId, studentId = S } = v.request.params;
    const got = await fetch(
      urlOf(base, assignmentId, studentId),
      v.request.headers === undefined ? {} : { headers: v.request.headers },
    );
    expect(got.status).toBe(v.response.status);
    expect(got.headers.get("cache-control")).toBe("no-store");
    expect(got.headers.get("set-cookie")).toBeNull();
    const text = await got.text();
    if (v.response.status === 200) {
      expect(JSON.parse(text)).toEqual(v.response.body);
    } else {
      expect(JSON.parse(text)).toEqual({
        ...v.response.body,
        requestId: got.headers.get("x-request-id"),
      });
    }
    const reached = v.response.status === 200 || v.response.status === 503;
    expect(calls).toEqual(reached ? [["teacherState", TOKEN, A, S]] : []);
  });

  it("a refusal of the database reads 404, the same as an unknown student", async () => {
    stored = async () => ({ ok: false, error: MY_SUBMISSION_STATE_NOT_FOUND });
    const base = await start();
    const got = await fetch(urlOf(base, A, S), { headers: { cookie: COOKIE } });
    expect(got.status).toBe(404);
    expect(calls).toEqual([["teacherState", TOKEN, A, S]]);
  });

  it("reads upper-case uuids as their lower-case form", async () => {
    const base = await start();
    const got = await fetch(urlOf(base, A.toUpperCase(), S.toUpperCase()), {
      headers: { cookie: COOKIE },
    });
    expect(got.status).toBe(200);
    expect(calls).toEqual([["teacherState", TOKEN, A, S]]);
  });

  it("a malformed id is 404 before the port", async () => {
    const base = await start();
    for (const [a, s] of [
      ["nije-uuid", S],
      [A, "nije-uuid"],
      [`${A}x`, S],
    ]) {
      const got = await fetch(urlOf(base, a!, s!), { headers: { cookie: COOKIE } });
      expect(got.status).toBe(404);
    }
    expect(calls).toEqual([]);
  });

  it("an answer outside the contract, or a throw, is 503", async () => {
    for (const answer of [
      async () => ({ ok: true, value: { state: "ceka", revision: 0, requestedAt: "jucer" } }),
      () => Promise.reject(new Error("izmisljena greska")),
    ]) {
      stored = answer;
      const base = await start();
      const got = await fetch(urlOf(base, A, S), { headers: { cookie: COOKIE } });
      expect(got.status).toBe(503);
      await running?.close();
      running = undefined;
    }
  });

  it("the teacher reads the same receipt bytes as the student (PRODUCT §5 rule 5)", async () => {
    const vector = STUDENT.find((v) => v.name === "potvrdeno")!;
    stored = async () => ({ ok: true, value: storedOf(vector.response.body) });
    const base = await start();
    const payload = vector.response.body.receipt as { payload: { assignmentId: string } };
    const id = payload.payload.assignmentId;
    const student = await fetch(`${base}/student/assignments/${id}/submission`, {
      headers: { cookie: STUDENT[0]!.request.headers!.cookie! },
    });
    const teacher = await fetch(urlOf(base, id, S), { headers: { cookie: COOKIE } });
    expect(teacher.status).toBe(200);
    expect(await teacher.text()).toBe(await student.text());
  });
});

// SRV-10: POST /api/v1/student/enrollments and POST
// /api/v1/student/assignments/{assignmentId}/notice-read on a real server with
// the real pipeline, over fake ports: every vector of both contracts a socket
// can reach, the order of the checks and the bodies' own rules. All values are
// invented.
import { readFileSync } from "node:fs";
import { connect } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import type { Enrollment, InstitutionEnrollment, NoticeReadOutcome } from "../database/index.ts";

import { createDatabases } from "./databases.ts";
import { createLayers } from "./pipeline.ts";
import { type Running, startServer } from "./start.ts";
import { createStudentWriteRoutes } from "./student-writes.ts";

type Vector = {
  name: string;
  request: {
    params?: Record<string, string>;
    headers: Record<string, string>;
    body?: unknown;
    rawBody?: string;
  };
  response: { status: number; body: Record<string, unknown> };
};
const vectorsOf = (id: string) =>
  (
    JSON.parse(
      readFileSync(new URL(`../contracts/vectors/${id}.json`, import.meta.url), "utf8"),
    ) as { vectors: Vector[] }
  ).vectors;
const ORIGIN = "https://ductura.example.invalid";
const ENROLL = "/api/v1/student/enrollments";
const NOTICE = (id: string) => `/api/v1/student/assignments/${id}/notice-read`;
const ASSIGNMENT = "4b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d01";

let server: Running | undefined;
const calls: unknown[][] = [];
const activity: string[] = [];
type EnrollResult = Awaited<ReturnType<InstitutionEnrollment["enrollWithCode"]>>;
let enrolled: EnrollResult = { ok: false, error: { code: "X", messageKey: "x" } };
let read: NoticeReadOutcome = { status: "unavailable" };

async function start() {
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    layers: createLayers({ expectedOrigin: ORIGIN }),
    databases: createDatabases(),
    routes: createStudentWriteRoutes({
      enrollment: {
        enrollWithCode: async (token, code) => {
          calls.push(["enroll", token, code]);
          return enrolled;
        },
      },
      noticeRead: {
        markRead: async (token, assignmentId, versionNo) => {
          calls.push(["read", token, assignmentId, versionNo]);
          return read;
        },
      },
      recordActivity: async (token) => activity.push(token),
      timeoutMs: 300,
    }),
  });
}
afterEach(async () => {
  enrolled = { ok: false, error: { code: "X", messageKey: "x" } };
  read = { status: "unavailable" };
  calls.length = 0;
  activity.length = 0;
  await server?.close();
  server = undefined;
});

type Answer = { status: number; head: Record<string, string>; body: string };
function send(raw: Buffer): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const socket = connect(server!.port, "127.0.0.1");
    let text = "";
    socket.write(raw);
    const finish = (): Answer => {
      const [head = "", ...rest] = text.split("\r\n\r\n");
      const headers: Record<string, string> = {};
      for (const field of head.split("\r\n").slice(1)) {
        const at = field.indexOf(":");
        headers[field.slice(0, at).toLowerCase()] = field.slice(at + 1).trim();
      }
      return { status: Number(head.split(" ")[1]), head: headers, body: rest.join("\r\n\r\n") };
    };
    socket.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
      if (!text.includes("\r\n\r\n")) return;
      const got = finish();
      if (Buffer.byteLength(got.body) >= Number(got.head["content-length"] ?? 0)) {
        socket.destroy();
        resolve(got);
      }
    });
    socket.on("error", reject);
    socket.on("close", () => resolve(finish()));
  });
}

function raw(path: string, headers: [string, string][], body: string): Buffer {
  const all: [string, string][] = [["host", "127.0.0.1"], ...headers];
  const framed = all.some(([k]) => /^(content-length|transfer-encoding)$/i.test(k));
  if (!framed) all.push(["content-length", String(Buffer.byteLength(body))]);
  const head = `POST ${path} HTTP/1.1\r\n${all.map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n`;
  return Buffer.concat([Buffer.from(head, "latin1"), Buffer.from(body)]);
}
const post = (path: string, body: string, headers: Record<string, string>) =>
  send(raw(path, Object.entries(headers), body));

// A short body under a longer Content-Length is a wait or a client gone on a
// real socket; the reader's own 400 is mutation-request.test.ts.
const UNREACHABLE = new Set(["content-length-mismatch", "body-stream-error"]);
const fail = (code: string): EnrollResult => ({ ok: false, error: { code, messageKey: "x" } });
const ENROLLED = (v: Vector): EnrollResult => ({ ok: true, value: v.response.body as Enrollment });
const ARRANGE: Record<string, (v: Vector) => void> = {
  "enrollments:enrolled": (v) => (enrolled = ENROLLED(v)),
  "enrollments:already-enrolled": (v) => (enrolled = ENROLLED(v)),
  "enrollments:enrolled-no-assignment": (v) => (enrolled = ENROLLED(v)),
  "enrollments:invalid-code": () => (enrolled = fail("ENROLLMENT_REFUSED")),
  "enrollments:expired-code": () => (enrolled = fail("ENROLLMENT_EXPIRED_CODE")),
  "enrollments:too-many-attempts": () => (enrolled = fail("ENROLLMENT_TOO_MANY_ATTEMPTS")),
  "enrollments:forbidden": () => (enrolled = fail("ENROLLMENT_FORBIDDEN")),
  "enrollments:unavailable": () => (enrolled = fail("ENROLLMENT_DATABASE_ERROR")),
  "enrollments:unauthorized": () => (enrolled = fail("ENROLLMENT_UNAUTHENTICATED")),
  "notice-read:unauthorized": () => (read = { status: "unauthenticated" }),
  "notice-read:read": (v) => (read = { status: "read", readAt: v.response.body.readAt as string }),
  "notice-read:not-found": () => (read = { status: "not_found" }),
  "notice-read:conflict": () => (read = { status: "conflict" }),
  "notice-read:unavailable": () => (read = { status: "unavailable" }),
};

describe.each(["enrollments", "notice-read"])("student.%s.post: every reachable vector", (id) => {
  const vectors = vectorsOf(`student.${id}.post`).filter((v) => !UNREACHABLE.has(v.name));
  it.each(vectors.map((v) => [v.name, v] as const))("%s", async (_name, v) => {
    ARRANGE[`${id}:${v.name}`]?.(v);
    await start();
    const path = id === "enrollments" ? ENROLL : NOTICE(v.request.params!.assignmentId!);
    const got = await post(
      path,
      v.request.rawBody ?? JSON.stringify(v.request.body),
      v.request.headers,
    );
    expect(got.status).toBe(v.response.status);
    if (v.name === "content-length-invalid") return; // Node's parser answers it itself.
    expect(got.head["cache-control"]).toBe("no-store");
    const json = JSON.parse(got.body) as Record<string, unknown>;
    if (got.status === 200) expect(json).toEqual(v.response.body);
    else expect(json).toEqual({ ...v.response.body, requestId: got.head["x-request-id"] });
    // Only a write the port accepted counts as activity.
    expect(activity).toHaveLength(got.status === 200 ? 1 : 0);
  });
});

describe("the bodies and the order of the checks", () => {
  const headers = vectorsOf("student.enrollments.post")[0]!.request.headers;
  const token = headers.cookie!.slice("__Host-ductus_session=".length);

  it("hands the code to the port as sent, at most 64 units; the RPC normalises it", async () => {
    enrolled = fail("ENROLLMENT_REFUSED");
    await start();
    expect((await post(ENROLL, '{"code":" ab-12 cd "}', headers)).status).toBe(422);
    expect(calls).toEqual([["enroll", token, " ab-12 cd "]]);
    expect((await post(ENROLL, JSON.stringify({ code: "x".repeat(65) }), headers)).status).toBe(
      422,
    );
    expect(calls).toHaveLength(1);
  });

  it.each([
    '{"code":"A","code":"B"}',
    '{"\\u0063ode":"IZMISLJENIKOD"}',
    '{"code":"IZMISLJENIKOD","x":1}',
    '{"code":12345678}',
    '["IZMISLJENIKOD"]',
  ])("refuses the enrolment body %s with 422 invalid_input and no call", async (body) => {
    await start();
    const got = await post(ENROLL, body, headers);
    expect([got.status, JSON.parse(got.body).code]).toEqual([422, "invalid_input"]);
    expect(calls).toEqual([]);
  });

  it.each([
    '{"versionNo":1,"versionNo":2}',
    '{"versionNo":1.5}',
    '{"versionNo":"2"}',
    '{"versionNo":2147483648}',
    "{}",
  ])("refuses the notice body %s with 422 invalid_input and no call", async (body) => {
    await start();
    const got = await post(NOTICE(ASSIGNMENT), body, headers);
    expect([got.status, JSON.parse(got.body).code]).toEqual([422, "invalid_input"]);
    expect(calls).toEqual([]);
  });

  it("judges the assignment id before the session, and hands the port the id in lower case", async () => {
    read = { status: "read", readAt: "2026-11-19T12:00:00.000Z" };
    await start();
    const anonymous = Object.fromEntries(Object.entries(headers).filter(([k]) => k !== "cookie"));
    const bad = await post(NOTICE("nije-uuid"), '{"versionNo":1}', anonymous);
    expect([bad.status, JSON.parse(bad.body).code]).toEqual([400, "invalid_assignment_id"]);
    const upper = await post(NOTICE(ASSIGNMENT.toUpperCase()), '{"versionNo":3}', headers);
    expect(upper.status).toBe(200);
    expect(calls).toEqual([["read", token, ASSIGNMENT, 3]]);
  });
});

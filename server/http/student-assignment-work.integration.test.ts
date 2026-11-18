// DAN-1084-1 (contract Ductus#2028 c.6967448047): GET /api/v1/student/assignment-work
// on a real server with the real pipeline, over the real reader of DAN-989-2a on a
// fake withActor that answers as app.student_workspace() does. Who asks comes only
// from the session cookie; one row the reader cannot vouch for is 503, never a
// partial list. Negative cases first. Every token and id is invented.
import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createMyAssignmentWorkReader,
  type MyAssignmentWorkReader,
  type WithActor,
} from "../database/index.ts";
import { sessionTag } from "../session/index.ts";

import { createDatabases } from "./databases.ts";
import { createLayers } from "./pipeline.ts";
import { type Running, startServer } from "./start.ts";
import { createStudentAssignmentWorkRoute } from "./student-assignment-work.ts";

type Vector = {
  name: string;
  request: { headers?: Record<string, string> };
  response: { status: number; body: Record<string, unknown> };
};
const VECTORS = (
  JSON.parse(
    readFileSync(
      new URL("../contracts/vectors/student.assignment-work.get.json", import.meta.url),
      "utf8",
    ),
  ) as { vectors: Vector[] }
).vectors;
const COOKIE = VECTORS.find((v) => v.name === "ready")!.request.headers!.cookie!;
const TOKEN = COOKIE.slice("__Host-ductus_session=".length);
const OTHER = "izmisljeni-token-drugog-studenta-0000000002";
const A1 = "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e01";
const A2 = "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e02";
const A3 = "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e03";
const DOC = "izmisljeni-dokument-0001";
const PATH = "/api/v1/student/assignment-work";

// The columns as the driver names them; built from entries, as they are no camelCase names.
const row = (id: unknown, document: unknown = null, revision: unknown = null): object =>
  Object.fromEntries([
    ["assignment_id", id],
    ["document_id", document],
    ["submitted_revision", revision],
  ]);
const READY = [row(A1, DOC), row(A2), row(A3, DOC, 2)];

let server: Running | undefined;
let tokens: unknown[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  tokens = [];
  await server?.close();
  server = undefined;
});

async function start(reader: MyAssignmentWorkReader) {
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    layers: createLayers({ expectedOrigin: "https://ductura.invalid" }),
    databases: createDatabases(),
    routes: [createStudentAssignmentWorkRoute({ reader })],
  });
}
/** The real reader over a withActor that answers rows, or throws `answer`. */
const startRows = (answer: unknown) =>
  start(
    createMyAssignmentWorkReader((async (token, fn) => {
      tokens.push(token);
      return fn({
        async query() {
          if (answer instanceof Error) throw answer;
          return { rows: answer as never[], rowCount: 0 };
        },
      });
    }) as WithActor),
  );
const thrown = (code?: string) => Object.assign(new Error("tajna poruka baze"), { code });

type Answer = { status: number; headers: Headers; body: Record<string, unknown> };
/** `null` sends no Cookie header. */
async function get(cookie: string | null = COOKIE, query = "", extra = {}): Promise<Answer> {
  const response = await fetch(`http://127.0.0.1:${server!.port}${PATH}${query}`, {
    headers: { ...(cookie === null ? {} : { cookie }), ...extra },
  });
  return {
    status: response.status,
    headers: response.headers,
    body: (await response.json()) as Record<string, unknown>,
  };
}
/** Every console.error line from now on. */
const logged = () => {
  const lines: string[] = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    lines.push(JSON.stringify(args));
  });
  return lines;
};
/** Neither the body nor any log line holds the token or the database's message. */
const noLeak = (got: Answer, lines: readonly string[]) => {
  for (const text of [JSON.stringify(got.body), ...lines]) {
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("tajna");
  }
};
const problem = (got: Answer) => [got.status, got.body.code, Object.keys(got.body).sort()];
const PROBLEM_KEYS = ["code", "error", "messageKey", "requestId", "status"];

describe("no session: 401 and the reader is never asked", () => {
  it.each([
    ["no cookie", null],
    ["empty", ""],
    ["42 characters", `__Host-ductus_session=${TOKEN.slice(1)}`],
    ["44 characters", `${COOKIE}A`],
    ["a plus", `__Host-ductus_session=${TOKEN.slice(1)}+`],
    ["two session cookies", `${COOKIE}; __Host-ductus_session=${OTHER}`],
    ["the same one twice", `${COOKIE}; ${COOKIE}`],
    ["an ended session", `${COOKIE}; ductus-ended-${sessionTag(TOKEN)!}=1`],
    ["only ductus_session", `ductus_session=${OTHER}`],
    ["only __Secure-ductus_session", `__Secure-ductus_session=${OTHER}`],
    // A token's shape, so the reader's own token check cannot hide a fallback.
    ["only a query", null, `?studentId=${OTHER}&token=${OTHER}`],
    ["only a header", null, "", { "x-student-id": OTHER, authorization: `Bearer ${OTHER}` }],
  ] as [string, string | null, string?, Record<string, string>?][])(
    "%s",
    async (_name, cookie, query = "", extra = {}) => {
      await startRows(READY);
      expect(problem(await get(cookie, query, extra))).toEqual([401, "unauthorized", PROBLEM_KEYS]);
      expect(tokens).toEqual([]);
    },
  );

  it("the port itself is never asked without a session", async () => {
    let reads = 0;
    await start({
      read: async () => {
        reads += 1;
        return { ok: true, value: [] };
      },
    });
    for (const cookie of [
      null,
      `__Host-ductus_session=${TOKEN.slice(1)}`,
      `ductus_session=${OTHER}`,
    ])
      expect((await get(cookie)).status).toBe(401);
    expect((await get(null, `?studentId=${OTHER}`, { "x-student-id": OTHER })).status).toBe(401);
    expect(reads).toBe(0);
  });

  it("ZD401 from the database reads as the same 401", async () => {
    const lines = logged();
    await startRows(thrown("ZD401"));
    const got = await get();
    expect(problem(got)).toEqual([401, "unauthorized", PROBLEM_KEYS]);
    noLeak(got, lines);
    expect(tokens).toEqual([TOKEN]);
  });
});

describe("one row the reader cannot vouch for: 503 and no partial list", () => {
  const proto = (json: string): object => JSON.parse(json) as object;
  it.each([
    ["an id ending in LF", row(`${A2}\n`)],
    ["an id ending in CRLF", row(`${A2}\r\n`)],
    ["an id with a tab", row(`\t${A2}`)],
    ["an id with NBSP", row(`${A2} `)],
    ["an id with DEL", row(`${A2}\u007f`)],
    ["an uppercase id", row(A2.toUpperCase())],
    ["an id that is a number", row(7)],
    ["an inherited id", Object.create(row(A2)) as object],
    [
      "own __proto__ and toString only",
      proto(`{"__proto__":{"assignment_id":"${A2}"},"toString":1}`),
    ],
    ["a document with NBSP at the edge", row(A2, `${DOC} `)],
    ["a document with a space at the edge", row(A2, ` ${DOC}`)],
    ["a document with a C0 character", row(A2, `izmisljeni\u0001dokument`)],
    ["a document with DEL", row(A2, `izmisljeni\u007fdokument`)],
    ["revision 0", row(A2, DOC, 0)],
    ["revision not a number", row(A2, DOC, "2x")],
    ["a submission without a document", row(A2, null, 1)],
    ["the same assignment in two states", row(A1)],
    ["null", null],
    ["a number", 3],
    ["an array", [A2]],
    [
      "a missing column",
      Object.fromEntries([
        ["assignment_id", A2],
        ["document_id", null],
      ]),
    ],
  ])("%s", async (_name, bad) => {
    const lines = logged();
    await startRows([...READY, bad]);
    const got = await get();
    expect(problem(got)).toEqual([503, "unavailable", PROBLEM_KEYS]);
    for (const id of [A1, A2, A3]) expect(JSON.stringify(got.body)).not.toContain(id);
    noLeak(got, lines);
    expect(tokens).toEqual([TOKEN]);
  });

  it("any other database error is 503 without its message", async () => {
    const lines = logged();
    await startRows(thrown("08006"));
    const got = await get();
    expect(problem(got)).toEqual([503, "unavailable", PROBLEM_KEYS]);
    noLeak(got, lines);
    expect(tokens).toEqual([TOKEN]);
  });
});

describe("a reader that answers something else", () => {
  /** A stub reader whose calls `tokens` counts. */
  const stub = (read: MyAssignmentWorkReader["read"]) =>
    start({
      read: (token) => {
        tokens.push(token);
        return read(token);
      },
    });
  /** The one report: a route server_error of this route and class, nothing else. */
  const oneReport = (lines: readonly string[], errorClass: string) => {
    expect(lines.length).toBe(1);
    const [record] = JSON.parse(lines[0]!) as [string];
    expect(JSON.parse(record)).toMatchObject({
      event: "server_error",
      where: "route",
      errorClass,
      route: "student.assignment-work.get",
    });
    expect(tokens).toEqual([TOKEN]);
  };

  it("a field beyond assignmentId and workState never leaves", async () => {
    await stub(async () => {
      const item = { assignmentId: A1, workState: "submitted" as const, studentId: OTHER };
      const value = Object.assign([item], { extra: OTHER });
      return Object.assign({ ok: true as const, value }, { extra: OTHER });
    });
    const got = await get();
    expect([got.status, got.body]).toEqual([
      200,
      { assignments: [{ assignmentId: A1, workState: "submitted" }] },
    ]);
  });

  it("an own map on the value is never called", async () => {
    const value = Object.assign([{ assignmentId: A1, workState: "submitted" as const }], {
      map: () => [{ studentId: OTHER }],
    });
    await stub(async () => ({ ok: true, value }));
    const got = await get();
    expect([got.status, got.body]).toEqual([
      200,
      { assignments: [{ assignmentId: A1, workState: "submitted" }] },
    ]);
  });

  // Review FAIL on 5511498 (c.6968017042): Array.from asked the value's own iterator.
  it("an own iterator that skips a bad item is never asked: 503, not a partial 200", async () => {
    let iterated = 0;
    const good = { assignmentId: A1, workState: "submitted" as const };
    const value = Object.assign([good, { assignmentId: A2, workState: "graded" }], {
      [Symbol.iterator]: function* () {
        iterated += 1;
        yield good;
      },
    });
    const lines = logged();
    await stub(async () => ({ ok: true, value: value as never }));
    const got = await get();
    expect(problem(got)).toEqual([503, "unavailable", PROBLEM_KEYS]);
    expect(JSON.stringify(got.body)).not.toContain(A1);
    expect(iterated).toBe(0);
    oneReport(lines, "type_error");
  });

  it("an unknown error code is 503 without a report", async () => {
    const lines = logged();
    await stub(async () => ({ ok: false, error: { code: "SOMETHING_ELSE", messageKey: "x.y" } }));
    expect(problem(await get())).toEqual([503, "unavailable", PROBLEM_KEYS]);
    expect(lines).toEqual([]);
    expect(tokens).toEqual([TOKEN]);
  });

  it.each([
    ["throws", () => Promise.reject(new Error("tajna poruka baze"))],
    [
      "throws synchronously",
      () => {
        throw new Error("tajna poruka baze");
      },
    ],
  ])("a reader that %s is 503 with one report and no message or token", async (_name, read) => {
    const lines = logged();
    await stub(read as MyAssignmentWorkReader["read"]);
    const got = await get();
    expect(problem(got)).toEqual([503, "unavailable", PROBLEM_KEYS]);
    oneReport(lines, "other");
    noLeak(got, lines);
  });

  const item = (fields: object) => [fields];
  it.each([
    ["not an array", { assignmentId: A1, workState: "submitted" }],
    [
      "inherited fields",
      item(Object.create({ assignmentId: A1, workState: "submitted" }) as object),
    ],
    ["a state outside the contract", item({ assignmentId: A1, workState: "graded" })],
    ["an uppercase id", item({ assignmentId: A1.toUpperCase(), workState: "submitted" })],
    ["a hole", [, { assignmentId: A1, workState: "submitted" }]],
  ])("a value with %s is 503 with one report, never a 200", async (_name, value) => {
    const lines = logged();
    await stub(async () => ({ ok: true, value: value as never }));
    const got = await get();
    expect(problem(got)).toEqual([503, "unavailable", PROBLEM_KEYS]);
    expect(JSON.stringify(got.body)).not.toContain(OTHER);
    oneReport(lines, "type_error");
  });
});

describe("identity only from the session cookie", () => {
  it.each([
    ["a query", `?studentId=${A1}`, {}, COOKIE],
    [
      "an encoded, repeated query",
      `?studentId=${encodeURIComponent(A2).replace(/./g, (c) => `%${c.charCodeAt(0).toString(16)}`)}&studentId=${A2}`,
      {},
      COOKIE,
    ],
    ["a header", "", { "x-student-id": A1 }, COOKIE],
    [
      "cookies of other names",
      "",
      {},
      `ductus_session=${OTHER}; ${COOKIE}; __Secure-ductus_session=${OTHER}`,
    ],
  ])("%s does not choose who asks", async (_name, query, extra, cookie) => {
    await startRows(READY);
    const got = await get(cookie, query, extra);
    expect(got.status).toBe(200);
    expect(got.body).toEqual(VECTORS.find((v) => v.name === "ready")!.response.body);
    expect(tokens).toEqual([TOKEN]);
  });
});

describe("the state of each assignment", () => {
  it.each([
    ["no work", row(A1), "not_started"],
    ["a work", row(A1, DOC), "in_progress"],
    ["a submission", row(A1, DOC, 1), "submitted"],
  ])("%s is %s, read once", async (_name, only, state) => {
    await startRows([only]);
    const got = await get();
    expect([got.status, got.body]).toEqual([
      200,
      { assignments: [{ assignmentId: A1, workState: state }] },
    ]);
    expect(tokens).toEqual([TOKEN]);
  });

  it.each(VECTORS.map((v) => [v.name, v] as const))("vector %s", async (name, v) => {
    const answers: Record<string, unknown> = {
      ready: READY,
      "ready-empty": [],
      unavailable: thrown("57P01"),
    };
    await startRows(answers[name] ?? READY);
    const got = await get(v.request.headers?.cookie ?? null);
    expect(got.status).toBe(v.response.status);
    expect(got.headers.get("content-type")?.split(";")[0]).toBe("application/json");
    expect(got.headers.get("cache-control")).toBe("no-store");
    expect(got.headers.get("set-cookie")).toBeNull();
    const requestId = got.headers.get("x-request-id");
    expect(got.body).toEqual(
      got.status === 200 ? v.response.body : { ...v.response.body, requestId },
    );
  });
});

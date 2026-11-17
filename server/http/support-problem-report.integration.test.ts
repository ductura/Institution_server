// DAN-851-2d1 (contract Ductus#1836 c.6947514907): POST
// /api/v1/support/problem-report on a real server with the real pipeline and
// the real support service, over a fake ProblemReportStore. Every vector is
// sent as its bytes, cookie included. Every refusal before the service leaves
// the port uncalled and counts no activity. All values are invented.
import { readFileSync } from "node:fs";
import { connect } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProblemReportStore } from "../database/index.ts";

import { createDatabases } from "./databases.ts";
import { createLayers } from "./pipeline.ts";
import { type Running, startServer } from "./start.ts";
import { createProblemReportRoute } from "./support-problem-report.ts";

type SubmitResult = Awaited<ReturnType<ProblemReportStore["submit"]>>;
type Report = Parameters<ProblemReportStore["submit"]>[1];
type Vector = {
  name: string;
  request: { headers?: Record<string, string>; body?: unknown; rawBody?: string };
  response: { status: number; body: Record<string, unknown> };
};
const VECTORS = (
  JSON.parse(
    readFileSync(
      new URL("../contracts/vectors/support.problem-report.post.json", import.meta.url),
      "utf8",
    ),
  ) as { vectors: Vector[] }
).vectors;
const vector = (name: string) => VECTORS.find((v) => v.name === name)!;
const RECORDED = vector("recorded");
const ORIGIN = RECORDED.request.headers!.origin!;
const COOKIE = RECORDED.request.headers!.cookie!;
const TOKEN = COOKIE.slice("__Host-ductus_session=".length);
const PATH = "/api/v1/support/problem-report";
const JSON_TYPE = "application/json";
const CANARY = "kanarinac-rad-7f3d Prvi odlomak rada";
// The vectors' bodies are in key order with plain values: JSON.stringify is their JCS form.
const BODY = JSON.stringify(RECORDED.request.body);
const WITH_CANARY = JSON.stringify({
  ...(RECORDED.request.body as Record<string, unknown>),
  description: `Izmišljeni opis ${CANARY}`,
});

const fail = (code: string) => ({ ok: false, error: { code, messageKey: "x.y" } }) as const;

let server: Running | undefined;
const calls = { submit: [] as [string, Report][], activity: [] as string[] };

async function start(
  submit: (report: Report) => Promise<SubmitResult> = async () => ({
    ok: true,
    value: "PR-0A1B2C3D4E",
  }),
  activity: (token: string) => Promise<unknown> = async () => undefined,
) {
  const store: ProblemReportStore = {
    submit: async (token, report) => {
      calls.submit.push([token, report]);
      return submit(report);
    },
  };
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    layers: createLayers({ expectedOrigin: ORIGIN }),
    databases: createDatabases(),
    routes: [
      createProblemReportRoute({
        store,
        recordActivity: (token) => {
          calls.activity.push(token);
          return activity(token);
        },
        timeoutMs: 300,
      }),
    ],
  });
}
afterEach(async () => {
  calls.submit.length = 0;
  calls.activity.length = 0;
  vi.restoreAllMocks();
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
      const got = finish();
      if (!text.includes("\r\n\r\n")) return;
      if (Buffer.byteLength(got.body) >= Number(got.head["content-length"] ?? 0)) {
        socket.destroy();
        resolve(got);
      }
    });
    socket.on("error", reject);
    socket.on("close", () => resolve(finish()));
  });
}

/** One request as bytes; `headers` is a list so a header can be sent twice. */
function raw(headers: [string, string][], body?: string | Buffer): Buffer {
  const all: [string, string][] = [["host", "127.0.0.1"], ...headers];
  const declared = all.some(([k]) => k.toLowerCase() === "content-length");
  if (body !== undefined && !declared)
    all.push(["content-length", String(Buffer.byteLength(body))]);
  const head = `POST ${PATH} HTTP/1.1\r\n${all.map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n`;
  return Buffer.concat([Buffer.from(head, "latin1"), Buffer.from(body ?? "")]);
}
const headersFor = (cookie = COOKIE, type = JSON_TYPE): [string, string][] => [
  ["origin", ORIGIN],
  ["sec-fetch-site", "same-origin"],
  ["content-type", type],
  ["cookie", cookie],
];
const post = (body: string | Buffer = BODY, headers = headersFor()) => send(raw(headers, body));
const codeOf = (got: Answer) => (JSON.parse(got.body) as { code: string }).code;
const untouched = () => {
  expect(calls.submit).toEqual([]);
  expect(calls.activity).toEqual([]);
};
function plainHeaders(got: Answer) {
  expect(got.head["content-type"]?.split(";")[0]).toBe(JSON_TYPE);
  expect(got.head["cache-control"]).toBe("no-store");
  expect(got.head["set-cookie"]).toBeUndefined();
}
/** Every stderr line written while `fn` runs, parsed. */
async function stderrOf(fn: () => Promise<unknown>): Promise<Record<string, unknown>[]> {
  const lines: string[] = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  await fn();
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

// A short body under a longer Content-Length is a wait (408) or a client gone
// on a real socket; the reader's own 400 is mutation-request.test.ts.
const UNREACHABLE = new Set(["content-length-mismatch", "body-stream-error"]);
const ANSWERS: Record<string, SubmitResult> = {
  "recorded-without-context": { ok: true, value: "PR-00000000FF" },
  "too-many-reports": fail("PROBLEM_REPORT_TOO_MANY"),
  unavailable: fail("PROBLEM_REPORT_DATABASE_ERROR"),
};
const REACHED = new Set([
  "recorded",
  "recorded-without-context",
  "too-many-reports",
  "unavailable",
]);

describe("every vector a socket can reach", () => {
  it.each(VECTORS.filter((v) => !UNREACHABLE.has(v.name)).map((v) => [v.name, v] as const))(
    "%s",
    async (name, v) => {
      const answer = ANSWERS[name];
      await start(answer === undefined ? undefined : async () => answer);
      const body = v.request.rawBody ?? JSON.stringify(v.request.body);
      const got = await send(raw(Object.entries(v.request.headers ?? {}), body));
      expect(got.status).toBe(v.response.status);
      expect(calls.submit.length).toBe(REACHED.has(name) ? 1 : 0);
      expect(calls.activity).toEqual(got.status === 201 ? [TOKEN] : []);
      if (name === "content-length-invalid") return; // Node's parser answers it itself.
      plainHeaders(got);
      const json = JSON.parse(got.body) as Record<string, unknown>;
      if (got.status === 201) expect(json).toEqual(v.response.body);
      else expect(json).toEqual({ ...v.response.body, requestId: got.head["x-request-id"] });
      if ([401, 413, 415, 408].includes(got.status)) expect(got.head.connection).toBe("close");
    },
  );
});

describe("the token comes before the media type and the body", () => {
  it("no cookie with text/plain is 401, not 415", async () => {
    await start();
    const got = await post(BODY, headersFor("x=y", "text/plain"));
    expect([got.status, codeOf(got)]).toEqual([401, "unauthorized"]);
    expect(got.head.connection).toBe("close");
    untouched();
  });

  it.each([
    ["two session cookies", `${COOKIE}; ${COOKIE}`],
    ["a token of 42 characters", `__Host-ductus_session=${TOKEN.slice(1)}`],
  ])("%s is 401", async (_name, cookie) => {
    await start();
    const got = await post(BODY, headersFor(cookie));
    expect([got.status, codeOf(got)]).toEqual([401, "unauthorized"]);
    untouched();
  });

  it("a session this browser ended reads as no cookie", async () => {
    const { sessionTag } = await import("../session/index.ts");
    await start();
    const got = await post(BODY, headersFor(`ductus-ended-${sessionTag(TOKEN)!}=1; ${COOKIE}`));
    expect([got.status, codeOf(got)]).toEqual([401, "unauthorized"]);
    untouched();
  });

  it("Content-Type sent twice is 415", async () => {
    await start();
    const got = await post(BODY, [...headersFor(), ["content-type", JSON_TYPE]]);
    expect([got.status, codeOf(got)]).toEqual([415, "unsupported_media_type"]);
    expect(got.head.connection).toBe("close");
    untouched();
  });

  it("a body over 8 KiB is 413 and closes the connection", async () => {
    await start();
    const got = await post("x".repeat(8 * 1024 + 1));
    expect([got.status, codeOf(got)]).toEqual([413, "body_too_large"]);
    expect(got.head.connection).toBe("close");
    untouched();
  });
});

describe("outcomes of the service and the port", () => {
  it.each([
    ["PROBLEM_REPORT_INVALID", 422, "invalid_input"],
    ["PROBLEM_REPORT_UNAUTHENTICATED", 401, "unauthorized"],
    ["PROBLEM_REPORT_TOO_MANY", 429, "too_many_reports"],
  ])("%s is %i %s, logged nowhere", async (code, status, contract) => {
    await start(async () => fail(code));
    const logged = await stderrOf(async () => {
      const got = await post();
      expect([got.status, codeOf(got)]).toEqual([status, contract]);
    });
    expect(logged).toEqual([]);
    expect(calls.activity).toEqual([]);
  });

  it.each([
    ["PROBLEM_REPORT_ROW_MALFORMED", "row_malformed"],
    ["PROBLEM_REPORT_DATABASE_ERROR", "database_error"],
    ["SOMETHING_ELSE", "unknown"],
  ])("%s is 503 with exactly one problem_report_fault (%s)", async (code, reason) => {
    await start(async () => fail(code));
    let requestId = "";
    const logged = await stderrOf(async () => {
      const got = await post(WITH_CANARY);
      expect([got.status, codeOf(got)]).toEqual([503, "unavailable"]);
      requestId = got.head["x-request-id"] ?? "";
      expect(got.body).not.toContain(CANARY);
    });
    expect(logged).toEqual([
      {
        event: "problem_report_fault",
        route: "support.problem-report.post",
        reason,
        requestId,
      },
    ]);
    expect(JSON.stringify(logged)).not.toContain(CANARY);
    expect(calls.activity).toEqual([]);
  });

  it("a port that throws is 503 with one server_error and no message or text", async () => {
    const SECRET = "tajna poruka baze";
    await start(() => Promise.reject(new Error(SECRET)));
    const logged = await stderrOf(async () => {
      const got = await post(WITH_CANARY);
      expect([got.status, codeOf(got)]).toEqual([503, "unavailable"]);
    });
    expect(logged.map((line) => line.event)).toEqual(["server_error"]);
    for (const leak of [SECRET, CANARY, TOKEN]) expect(JSON.stringify(logged)).not.toContain(leak);
    expect(calls.activity).toEqual([]);
  });

  it.each([
    ["not JSON", "{", 400, "invalid_json"],
    ["not canonical", JSON.stringify(RECORDED.request.body, null, 1), 422, "invalid_input"],
    [
      "work text in a key",
      WITH_CANARY.replace('{"appVersion"', `{"title":"${CANARY}","appVersion"`),
      422,
      "invalid_input",
    ],
  ])("%s is refused by the service before the port", async (_name, body, status, contract) => {
    await start();
    const logged = await stderrOf(async () => {
      const got = await post(body);
      expect([got.status, codeOf(got)]).toEqual([status, contract]);
      plainHeaders(got);
    });
    expect(logged).toEqual([]);
    untouched();
  });
});

describe("session activity", () => {
  it("a 201 sends the parser's report once and counts activity once", async () => {
    await start();
    const got = await post();
    expect(got.status).toBe(201);
    expect(JSON.parse(got.body)).toEqual({ reference: "PR-0A1B2C3D4E" });
    expect(calls.submit).toEqual([
      [
        TOKEN,
        {
          category: "technical",
          description: (RECORDED.request.body as { description: string }).description,
          route: "/zadaci",
          appVersion: "1.4.0",
          browserFamily: "firefox",
          browserMajor: 140,
          syncState: "SYNCED",
        },
      ],
    ]);
    expect(calls.activity).toEqual([TOKEN]);
  });

  it("an activity that fails does not change the 201", async () => {
    await start(undefined, () => Promise.reject(new Error("dodir nije uspio")));
    expect((await post()).status).toBe(201);
    expect(calls.activity).toEqual([TOKEN]);
  });

  it("an activity that never settles does not hold the 201", async () => {
    await start(undefined, () => new Promise(() => undefined));
    expect((await post()).status).toBe(201);
  });
});

// DAN-811, plan of attack ductura/server#107 parts B, E and G: the open route
// on a real server with the real pipeline and router, over a fake work opener.
// Every vector of evidence.open.post is sent as its bytes and answered as the
// vector says (403 by status only: pipeline step 7, docs/vs1-rute.md). The
// database itself is tests/db/evidence-open.integration.test.ts. Every token
// and identifier is invented.
import { readFileSync } from "node:fs";
import { connect } from "node:net";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type ActorReader,
  OPEN_WORK_DATABASE_ERROR,
  OPEN_WORK_NOT_ACCEPTING,
  OPEN_WORK_NOT_CONFIGURED,
  OPEN_WORK_NOT_FOUND,
  OPEN_WORK_NOT_STARTED,
  OPEN_WORK_ROW_MALFORMED,
  OPEN_WORK_UNAUTHENTICATED,
  type OpenWorkResult,
  type WorkOpener,
} from "../database/index.ts";

import { createDatabases } from "./databases.ts";
import { createEvidenceOpenRoute, OPEN_PROTOCOLS } from "./evidence-open.ts";
import { createLayers } from "./pipeline.ts";
import { type Running, startServer } from "./start.ts";

type Vector = {
  name: string;
  request: { headers: Record<string, string>; body?: unknown; rawBody?: string };
  response: { status: number; headers: Record<string, string>; body: Record<string, unknown> };
};
const { vectors } = JSON.parse(
  readFileSync(new URL("../contracts/vectors/evidence.open.post.json", import.meta.url), "utf8"),
) as { vectors: Vector[] };
const ORIGIN = vectors[0]!.request.headers.origin!;
const TOKEN = "izmisljeni-token-evidencije-000000000000001";
const A1 = "00000000-0000-4000-8000-0000000000a1";

let next: () => Promise<OpenWorkResult> = async () => ({ ok: false, error: OPEN_WORK_NOT_FOUND });
const calls: { token: string; assignmentId: string; start: boolean }[] = [];
const opener: WorkOpener = {
  openWork(token, assignmentId, start) {
    calls.push({ token, assignmentId, start });
    return next();
  },
};
const actors: ActorReader = {
  currentActor: () => Promise.reject(new Error("open does not ask the session first")),
  currentActorWithInstitution: () => Promise.reject(new Error("not used")),
};

const OPEN_WORK_ERRORS_BY_STATUS = new Map<unknown, typeof OPEN_WORK_NOT_FOUND>([
  ["unauthenticated", OPEN_WORK_UNAUTHENTICATED],
  ["not_found", OPEN_WORK_NOT_FOUND],
  ["not_accepting", OPEN_WORK_NOT_ACCEPTING],
  ["not_started", OPEN_WORK_NOT_STARTED],
]);

/** The opener's answer that leads to this vector's response. */
function outcomeOf(v: Vector): OpenWorkResult {
  const body = v.response.body;
  if (v.response.status === 200) {
    const work: Record<string, unknown> = { ...body };
    const snapshot = Buffer.from(String(work.document), "base64").toString("utf8");
    delete work.status;
    delete work.document;
    return { ok: true, value: { ...work, snapshot } } as unknown as OpenWorkResult;
  }
  const error = OPEN_WORK_ERRORS_BY_STATUS.get(body.status) ?? OPEN_WORK_ROW_MALFORMED;
  return { ok: false, error };
}

type Answer = { status: number; head: Record<string, string>; body: string };
function send(raw: string): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const socket = connect(server.port, "127.0.0.1");
    let text = "";
    socket.write(raw);
    socket.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
      const [head = "", ...rest] = text.split("\r\n\r\n");
      const headers: Record<string, string> = {};
      for (const field of head.split("\r\n").slice(1)) {
        const at = field.indexOf(":");
        headers[field.slice(0, at).toLowerCase()] = field.slice(at + 1).trim();
      }
      const body = rest.join("\r\n\r\n");
      if (Buffer.byteLength(body) >= Number(headers["content-length"])) {
        socket.destroy();
        resolve({ status: Number(head.split(" ")[1]), head: headers, body });
      }
    });
    socket.on("error", reject);
    // Node's own parser answers some requests (400) without a body and closes.
    socket.on("close", () => {
      const [head = ""] = text.split("\r\n\r\n");
      resolve({ status: Number(head.split(" ")[1]), head: {}, body: "" });
    });
  });
}

function request(headers: Record<string, string>, body: string): string {
  const all = { host: "127.0.0.1", "content-length": String(Buffer.byteLength(body)), ...headers };
  const lines = Object.entries(all).map(([k, v]) => `${k}: ${v}`);
  return `POST /api/v1/evidence/open HTTP/1.1\r\n${lines.join("\r\n")}\r\n\r\n${body}`;
}

const GOOD = vectors.find((v) => v.name === "opened")!.request.headers;
const post = (body: string, headers: Record<string, string> = {}) =>
  send(request({ ...GOOD, ...headers }, body));

let server: Running;
beforeAll(async () => {
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    layers: createLayers({ expectedOrigin: ORIGIN }),
    databases: createDatabases(),
    routes: [createEvidenceOpenRoute({ actorReader: actors, workOpener: opener, timeoutMs: 300 })],
  });
});
afterAll(async () => server.close());
beforeEach(() => {
  calls.length = 0;
  next = async () => ({ ok: false, error: OPEN_WORK_NOT_FOUND });
});

describe("G. every vector of evidence.open.post", () => {
  it.each(vectors.map((v) => [v.name, v] as const))("%s", async (_name, v) => {
    next = async () => outcomeOf(v);
    const body = v.request.rawBody ?? JSON.stringify(v.request.body);
    const answer = await send(request(v.request.headers, body));
    expect(answer.status).toBe(v.response.status);
    // Content-Length -1 is refused by Node's parser before any route: status only.
    if (v.name === "bad-request") return;
    expect(answer.head["cache-control"]).toBe("no-store");
    expect(answer.head["set-cookie"]).toBeUndefined();
    if (v.name === "forbidden") return;
    expect(answer.head["content-type"]).toBe("application/json; charset=utf-8");
    for (const [key, value] of Object.entries(v.response.headers)) {
      expect(answer.head[key]).toBe(value);
    }
    expect(JSON.parse(answer.body)).toEqual(v.response.body);
  });
});

describe("B. the closed body", () => {
  it.each([
    ["no start", `{"assignmentId":"${A1}"}`, false],
    ["start false", `{"assignmentId":"${A1}","start":false}`, false],
    ["start true", `{"start":true,"assignmentId":"${A1}"}`, true],
    ["an assignment in capitals", `{"assignmentId":"${A1.toUpperCase()}"}`, false],
  ])("%s reaches the opener with the session's token", async (_name, body, start) => {
    await post(body);
    expect(calls).toEqual([{ token: TOKEN, assignmentId: JSON.parse(body).assignmentId, start }]);
  });

  it.each([
    ["start as text", `{"assignmentId":"${A1}","start":"true"}`],
    ["start as 1", `{"assignmentId":"${A1}","start":1}`],
    ["start null", `{"assignmentId":"${A1}","start":null}`],
    ["start an object", `{"assignmentId":"${A1}","start":{}}`],
    ["no assignment", "{}"],
    ["only start", '{"start":true}'],
    ["an assignment of 35 characters", `{"assignmentId":"${A1.slice(1)}"}`],
    ["an assignment with braces", `{"assignmentId":"{${A1}}"}`],
    ["an urn", `{"assignmentId":"urn:uuid:${A1}"}`],
    ["an assignment with a space", `{"assignmentId":" ${A1}"}`],
    ["an assignment as a number", '{"assignmentId":1}'],
    ["a user id", `{"assignmentId":"${A1}","userId":"${A1}"}`],
    ["__proto__", `{"assignmentId":"${A1}","__proto__":{"start":true}}`],
    ["an array", `["${A1}"]`],
    ["not JSON", "assignmentId"],
    ["an empty body", ""],
  ])("%s is 422 invalid and never reaches the opener", async (_name, body) => {
    const answer = await post(body);
    expect(answer.status).toBe(422);
    expect(JSON.parse(answer.body)).toEqual({ status: "invalid" });
    expect(calls).toEqual([]);
  });
});

describe("E. failures of the opener", () => {
  it("E1, E5: a throw is 503 context; the record has the class only, never the message or token", async () => {
    const lines: string[] = [];
    const stderr = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
    try {
      next = () => Promise.reject(new Error(`kanarinac ${TOKEN}`));
      const answer = await post(`{"assignmentId":"${A1}"}`);
      expect(answer.status).toBe(503);
      expect(answer.head["retry-after"]).toBe("5");
      expect(JSON.parse(answer.body)).toEqual({ status: "unavailable", stage: "context" });
      expect(answer.body).not.toContain("kanarinac");
    } finally {
      stderr.mockRestore();
    }
    // Exactly one record, of the route and the error's class, with nothing of the error or token.
    const records = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records).toEqual([
      {
        event: "server_error",
        where: "route",
        errorClass: expect.any(String),
        requestId: expect.any(String),
        route: "evidence.open.post",
      },
    ]);
    for (const line of lines) {
      expect(line).not.toContain("kanarinac");
      expect(line).not.toContain(TOKEN);
    }
  });

  it("E1: a database error is 503 context with one record of class other, nothing else", async () => {
    const lines: string[] = [];
    const stderr = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
    try {
      next = async () => ({ ok: false, error: OPEN_WORK_DATABASE_ERROR });
      const answer = await post(`{"assignmentId":"${A1}"}`);
      expect(answer.status).toBe(503);
      expect(answer.head["retry-after"]).toBe("5");
      expect(JSON.parse(answer.body)).toEqual({ status: "unavailable", stage: "context" });
    } finally {
      stderr.mockRestore();
    }
    expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual([
      {
        event: "server_error",
        where: "route",
        errorClass: "other",
        requestId: expect.any(String),
        route: "evidence.open.post",
      },
    ]);
  });

  it.each([
    OPEN_WORK_ROW_MALFORMED,
    OPEN_WORK_NOT_CONFIGURED,
    { code: "OPEN_WORK_SOMETHING_NEW", messageKey: "openWork.something_new" },
  ])("$code is 503 context, the code never in the answer", async (error) => {
    next = async () => ({ ok: false, error });
    const answer = await post(`{"assignmentId":"${A1}"}`);
    expect(answer.status).toBe(503);
    expect(answer.head["retry-after"]).toBe("5");
    expect(JSON.parse(answer.body)).toEqual({ status: "unavailable", stage: "context" });
  });

  it("D1: the snapshot goes out as base64 of its exact UTF-8 bytes", async () => {
    const snapshot = '{"naslov":"Čćžšđ – ✓"}';
    const open = outcomeOf(vectors.find((v) => v.name === "opened")!);
    if (!open.ok) throw new Error("vector");
    next = async () => ({ ok: true, value: { ...open.value, snapshot } });
    const answer = await post(`{"assignmentId":"${A1}"}`);
    expect(Buffer.from(JSON.parse(answer.body).document, "base64").toString("utf8")).toBe(snapshot);
  });
});

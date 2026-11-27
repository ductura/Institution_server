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
  type ActorTransaction,
  createWorkOpener,
  OPEN_WORK_DATABASE_ERROR,
  OPEN_WORK_NOT_ACCEPTING,
  OPEN_WORK_NOT_CONFIGURED,
  OPEN_WORK_NOT_FOUND,
  OPEN_WORK_NOT_STARTED,
  OPEN_WORK_ROW_MALFORMED,
  OPEN_WORK_UNAUTHENTICATED,
  type OpenWorkResult,
  type WithActor,
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

// Ductus src/server/evidence/open-route.test.ts tested the route and its SQL
// as one module. Ductura splits them (this route, server/database/open-work.ts);
// the cases that only held across both run here: this route over the real
// opener and a scripted transaction. Every value is invented.
describe("Ductus open-route: the route over the real opener", () => {
  const DOMAIN = "00000000-0000-4000-8000-0000000000d1";
  const OPENED = {
    outcome: "opened",
    document_id: "dokument-izmisljeni-1",
    evidence_profile_id: "standard-v1",
    current_revision: "2",
    document_hash: "a".repeat(64),
    head_segment_hash: "b".repeat(64),
    last_sequence_to: "7",
    snapshot: '{"nodes":[],"naslov":"Izmišljeni"}',
  };
  const KEY = {
    key_id: "kljuc-r",
    key_version: "1",
    evidence_domain_id: DOMAIN,
    purpose: "receipt",
    algorithm: "Ed25519",
    key_base64url: "MCowBQYDK2VwAyEA" + "A".repeat(43),
    valid_from: "2026-11-01T10:00:00.000Z",
    valid_to: null,
    revoked_at: null,
  };
  // SRV-7F: the v3 revision 0 as contract v3 §6 writes it.
  const V3_ZERO = "b6d1831785f40ae90b5a44a70d28b401913eecd347f02961f14874734fcd9141";
  // The column of the work's kind (a computed key: the lint takes no snake_case key).
  const KIND_COLUMN = "document_kind";
  const seen: { text: string; values: readonly unknown[] | undefined }[] = [];
  function realOpener(
    submitted: Record<string, unknown>[],
    revisionZero: Record<string, unknown>[] = [{ content_hash: V3_ZERO }],
  ) {
    seen.length = 0;
    const withActor = (async (_token, fn) => {
      const tx: ActorTransaction = {
        async query(text, values) {
          seen.push({ text, values });
          const rows = text.includes("open_student_work")
            ? [OPENED]
            : text.includes("work_submitted")
              ? submitted
              : text.includes("SELECT document_kind")
                ? [{ [KIND_COLUMN]: "text" }]
                : text.includes("evidence.document_revision")
                  ? revisionZero
                  : text.includes("evidence.package")
                    ? [{ evidence_domain_id: DOMAIN, last_signed_at: "2026-11-20T09:41:00.000Z" }]
                    : [KEY];
          return { rows: rows as never[], rowCount: rows.length };
        },
      };
      return fn(tx);
    }) as WithActor;
    const real = createWorkOpener(withActor);
    next = () => {
      const call = calls.at(-1)!;
      return real.openWork(call.token, call.assignmentId, call.start);
    };
  }

  it("opens with its state and keys; package and institution never go on the wire", async () => {
    realOpener([{ submitted: false }]);
    const answer = await post(`{"assignmentId":"${A1}"}`);
    expect(answer.status).toBe(200);
    const body = JSON.parse(answer.body) as Record<string, unknown>;
    expect(body).toMatchObject({
      status: "opened",
      documentId: "dokument-izmisljeni-1",
      currentRevision: 2,
      headSegmentHash: "b".repeat(64),
      lastSequenceTo: 7,
      schemaVersion: 3,
      revisionZeroHash: V3_ZERO,
      receiptKeys: [expect.objectContaining({ keyId: "kljuc-r", purpose: "receipt" })],
      submitted: false,
      lastSignedAt: "2026-11-20T09:41:00.000Z",
    });
    expect(answer.body).not.toMatch(/package|institution/i);
    expect(seen.map((q) => q.values)).toEqual([
      [A1, false],
      [A1],
      ["dokument-izmisljeni-1"],
      ["dokument-izmisljeni-1"],
      ["dokument-izmisljeni-1"],
      [DOMAIN],
    ]);
    expect(seen[0]?.text).toMatch(/app\.open_student_work\(\$1::uuid, \$2::boolean\)/);
    expect(seen[1]?.text).toMatch(/app\.work_submitted\(\$1::uuid\)/);
  });

  it.each([true, false])(
    "carries submitted exactly as the database answers it (%s)",
    async (value) => {
      realOpener([{ submitted: value }]);
      const answer = await post(`{"assignmentId":"${A1}","start":true}`);
      expect(answer.status).toBe(200);
      expect(JSON.parse(answer.body).submitted).toBe(value);
      expect(seen[0]?.values).toEqual([A1, true]);
    },
  );

  // SRV-7F: a revision 0 that names no version is no answer, never a guessed one.
  it.each([
    ["no revision 0", []],
    ["a hash that is no revision 0", [{ content_hash: "c".repeat(64) }]],
  ])("is 503 context when the work has %s", async (_name, rows) => {
    realOpener([{ submitted: false }], rows);
    const answer = await post(`{"assignmentId":"${A1}"}`);
    expect(answer.status).toBe(503);
    expect(JSON.parse(answer.body)).toEqual({ status: "unavailable", stage: "context" });
  });

  it.each([
    ["a string", [{ submitted: "true" }]],
    ["a number", [{ submitted: 0 }]],
    ["null", [{ submitted: null }]],
    ["no column", [{}]],
    ["no row", []],
    ["two rows", [{ submitted: true }, { submitted: true }]],
  ])("is 503 context when submitted is %s, never false by assumption", async (_name, rows) => {
    realOpener(rows);
    const answer = await post(`{"assignmentId":"${A1}"}`);
    expect(answer.status).toBe(503);
    expect(JSON.parse(answer.body)).toEqual({ status: "unavailable", stage: "context" });
  });

  // DAN-518: protocol 2 is the commit route's alone; open takes only "1".
  it.each([
    ["Ductus-Protocol 2", { "ductus-protocol": "2" }],
    ["Ductus-Protocol 0", { "ductus-protocol": "0" }],
  ])("refuses %s as 426 before the opener", async (_name, headers) => {
    expect(OPEN_PROTOCOLS).toEqual(["1"]);
    const answer = await post(`{"assignmentId":"${A1}"}`, headers);
    expect(answer.status).toBe(426);
    expect(JSON.parse(answer.body)).toEqual({ status: "upgrade_required" });
    expect(calls).toEqual([]);
  });

  it("never lets the database default decide: the opener names both arguments", () => {
    const source = readFileSync(new URL("../database/open-work.ts", import.meta.url), "utf8");
    expect(source.match(/open_student_work\([^)]*\)/g)).toEqual([
      "open_student_work($1::uuid, $2::boolean)",
    ]);
  });
});

// DAN-815 b2, plan of attack ductura/server#119 parts A, B, C, E, F4 and G:
// the commit route on a real server with the real pipeline and router, over
// a fake evidence service. Every vector of evidence.commit.post is sent as
// its bytes and answered as the vector says (403 by status only: pipeline
// step 7, docs/vs1-rute.md; bad-request is the 400 of client-error.ts). The
// service is server/evidence/service.test.ts, the database
// tests/db/evidence-commit.integration.test.ts. Every token and id is invented.
import { readFileSync } from "node:fs";
import { connect } from "node:net";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { ActorReader, CurrentActor } from "../database/index.ts";
import {
  type EvidenceCommitRequest,
  type EvidenceCommitRequestOutcome,
  type EvidenceService,
  MAX_COMMIT_REQUEST_BYTES,
} from "../evidence/index.ts";

import { createDatabases } from "./databases.ts";
import { createEvidenceCommitRoute } from "./evidence-commit.ts";
import { createLayers } from "./pipeline.ts";
import { type Running, startServer } from "./start.ts";

type Vector = {
  name: string;
  request: { headers: Record<string, string>; body?: unknown; rawBody?: string };
  response: { status: number; headers: Record<string, string>; body: Record<string, unknown> };
};
const { vectors } = JSON.parse(
  readFileSync(new URL("../contracts/vectors/evidence.commit.post.json", import.meta.url), "utf8"),
) as { vectors: Vector[] };
const ORIGIN = vectors[0]!.request.headers.origin!;
const TOKEN = "izmisljeni-token-evidencije-000000000000001";

let next: () => Promise<EvidenceCommitRequestOutcome> = async () => ({ status: "not_found" });
const calls: { token: string; request: EvidenceCommitRequest; signing: unknown }[] = [];
const evidence: EvidenceService = {
  commit(token, request, signing) {
    calls.push({ token, request, signing });
    return next();
  },
};
let actor: () => Promise<CurrentActor> = async () => ({ userId: "u1", institutionId: "i1" });
let actorCalls = 0;
const actors: ActorReader = {
  currentActor: () => {
    actorCalls += 1;
    return actor();
  },
  currentActorWithInstitution: () => Promise.reject(new Error("not used")),
};

/** The service's answer that leads to this vector's response. */
function outcomeOf(v: Vector): EvidenceCommitRequestOutcome {
  const body = v.response.body as Record<string, unknown> & { receipt?: Record<string, unknown> };
  const { status, ...rest } = body;
  if (v.response.status === 200) {
    return {
      status,
      revision: body.revision,
      signedReceipt: body.receipt?.signedReceipt,
    } as EvidenceCommitRequestOutcome;
  }
  if (v.response.status === 202) {
    const pending = status === "committed" ? "committed_pending" : "duplicate_pending";
    return { status: pending, revision: body.revision as number };
  }
  if (v.response.status === 503) {
    return { status: "unavailable", stage: body.stage, code: "x" } as never;
  }
  if (Object.keys(rest).length > 0) return { status, state: rest } as never;
  return { status } as EvidenceCommitRequestOutcome;
}

type Answer = { status: number; head: Record<string, string>; body: string };
function send(raw: string, end = true): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const socket = connect(server.port, "127.0.0.1");
    let text = "";
    socket.write(raw);
    if (!end) socket.on("connect", () => undefined);
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
    socket.on("close", () => {
      const [head = ""] = text.split("\r\n\r\n");
      resolve({ status: Number(head.split(" ")[1]), head: {}, body: "" });
    });
  });
}

function request(headers: Record<string, string>, body: string, length?: string): string {
  const all = {
    host: "127.0.0.1",
    "content-length": length ?? String(Buffer.byteLength(body)),
    ...headers,
  };
  const lines = Object.entries(all).map(([k, v]) => `${k}: ${v}`);
  return `POST /api/v1/evidence/commit HTTP/1.1\r\n${lines.join("\r\n")}\r\n\r\n${body}`;
}

const COMMITTED = vectors.find((v) => v.name === "committed")!;
const GOOD = COMMITTED.request.headers;
const GOOD_BODY = COMMITTED.request.body as Record<string, unknown>;
const post = (body: string, headers: Record<string, string> = {}) =>
  send(request({ ...GOOD, ...headers }, body));
const envelope = (change: Record<string, unknown>) => JSON.stringify({ ...GOOD_BODY, ...change });

let server: Running;
let plain: Running;
beforeAll(async () => {
  const common = {
    host: "127.0.0.1",
    port: 0,
    layers: createLayers({ expectedOrigin: ORIGIN }),
    databases: createDatabases(),
  };
  // The vectors of protocol 2 need it on; VS-1 runs with it off (`plain`).
  server = await startServer({
    ...common,
    routes: [
      createEvidenceCommitRoute({
        actorReader: actors,
        evidence,
        asyncSigning: true,
        timeoutMs: 300,
      }),
    ],
  });
  plain = await startServer({
    ...common,
    routes: [createEvidenceCommitRoute({ actorReader: actors, evidence, timeoutMs: 300 })],
  });
});
afterAll(async () => {
  await server.close();
  await plain.close();
});
beforeEach(() => {
  calls.length = 0;
  actorCalls = 0;
  next = async () => ({ status: "not_found" });
  actor = async () => ({ userId: "u1", institutionId: "i1" });
});

describe("G. every vector of evidence.commit.post", () => {
  it.each(vectors.map((v) => [v.name, v] as const))("%s", async (_name, v) => {
    next = async () => outcomeOf(v);
    const body = v.request.rawBody ?? JSON.stringify(v.request.body);
    const answer = await send(request(v.request.headers, body));
    expect(answer.status).toBe(v.response.status);
    expect(answer.head["cache-control"]).toBe("no-store");
    expect(answer.head["set-cookie"]).toBeUndefined();
    if (v.name === "forbidden") return;
    expect(answer.head["content-type"]).toBe("application/json; charset=utf-8");
    for (const [key, value] of Object.entries(v.response.headers)) {
      expect(answer.head[key]).toBe(value);
    }
    expect(JSON.parse(answer.body)).toEqual(v.response.body);
  });

  it("hands the decoded bytes and the session's token to the service, signing inline", async () => {
    await post(JSON.stringify(GOOD_BODY));
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.token).toBe(TOKEN);
    expect(call?.signing).toBe("inline");
    expect(Buffer.from(call!.request.segment).toString("base64")).toBe(
      (GOOD_BODY.segments as string[])[0],
    );
    expect(Buffer.from(call!.request.document).toString("base64")).toBe(GOOD_BODY.document);
    // Buffers of their own, never a view into Node's pool.
    for (const bytes of [call!.request.segment, call!.request.document]) {
      expect(bytes.byteOffset).toBe(0);
      expect(bytes.buffer.byteLength).toBe(bytes.byteLength);
    }
  });

  it("E8: protocol 2 asks the service to defer signing; protocol 1 never does", async () => {
    const pending = vectors.find((v) => v.name === "committed-pending-signature")!;
    await send(request(pending.request.headers, JSON.stringify(pending.request.body)));
    await post(JSON.stringify(GOOD_BODY));
    expect(calls.map((call) => call.signing)).toEqual(["deferred", "inline"]);
  });

  it("E8: without async signing, protocol 2 is 426 and the service is never asked", async () => {
    const pending = vectors.find((v) => v.name === "committed-pending-signature")!;
    const body = JSON.stringify(pending.request.body);
    const raw = request(pending.request.headers, body);
    const answer = await new Promise<Answer>((resolve, reject) => {
      const socket = connect(plain.port, "127.0.0.1");
      let text = "";
      socket.write(raw);
      socket.on("data", (c: Buffer) => (text += c.toString("utf8")));
      socket.on("error", reject);
      socket.on("close", () => {
        const [head = "", ...rest] = text.split("\r\n\r\n");
        resolve({ status: Number(head.split(" ")[1]), head: {}, body: rest.join("") });
      });
    });
    expect(answer.status).toBe(426);
    expect(calls).toEqual([]);
  });
});

describe("A. the session before the body", () => {
  it("A4: a session the database calls signed out is 401 and the service is never asked", async () => {
    actor = async () => ({ userId: null, institutionId: null });
    const answer = await post(JSON.stringify(GOOD_BODY));
    expect(answer.status).toBe(401);
    expect(JSON.parse(answer.body)).toEqual({ status: "unauthenticated" });
    expect(actorCalls).toBe(1);
    expect(calls).toEqual([]);
  });

  it("A5: a failing session check is 503 context with retry-after 5", async () => {
    actor = () => Promise.reject(new Error("veza prekinuta"));
    const answer = await post(JSON.stringify(GOOD_BODY));
    expect(answer.status).toBe(503);
    expect(answer.head["retry-after"]).toBe("5");
    expect(JSON.parse(answer.body)).toEqual({ status: "unavailable", stage: "context" });
    expect(calls).toEqual([]);
  });

  it("A6: a declared length over the limit is 413 without asking the database", async () => {
    actor = async () => ({ userId: null, institutionId: null });
    const answer = await send(request(GOOD, "", "99999999"));
    expect(answer.status).toBe(413);
    expect(actorCalls).toBe(0);
  });
});

describe("B. the request limit is the domain's", () => {
  it("B1: a body of exactly MAX_COMMIT_REQUEST_BYTES is read and reaches the service", async () => {
    const base = JSON.stringify({ ...GOOD_BODY, document: "" });
    const length = Math.floor((MAX_COMMIT_REQUEST_BYTES - base.length) / 4) * 4;
    const json = JSON.stringify({ ...GOOD_BODY, document: "A".repeat(length) });
    const body = json + " ".repeat(MAX_COMMIT_REQUEST_BYTES - json.length);
    expect(Buffer.byteLength(body)).toBe(MAX_COMMIT_REQUEST_BYTES);
    const answer = await post(body);
    expect(answer.status).toBe(404);
    expect(calls).toHaveLength(1);
  });

  it("B1: a chunked body one byte over the limit is 413 and never reaches the service", async () => {
    const size = MAX_COMMIT_REQUEST_BYTES + 1;
    const lines = Object.entries({
      host: "127.0.0.1",
      ...GOOD,
      "transfer-encoding": "chunked",
    }).map(([k, v]) => `${k}: ${v}`);
    const raw =
      `POST /api/v1/evidence/commit HTTP/1.1\r\n${lines.join("\r\n")}\r\n\r\n` +
      `${size.toString(16)}\r\n${" ".repeat(size)}\r\n0\r\n\r\n`;
    const answer = await send(raw);
    expect(answer.status).toBe(413);
    expect(calls).toEqual([]);
  });
});

describe("C. the closed envelope", () => {
  const segment = (GOOD_BODY.segments as string[])[0]!;
  it.each([
    ["an unknown field", envelope({ gap: true })],
    ["the institution", envelope({ institutionId: "i1" })],
    ["__proto__", JSON.stringify(GOOD_BODY).replace("{", '{"__proto__":{},')],
    ["no document", JSON.stringify({ ...GOOD_BODY, document: undefined })],
    ["no segments", envelope({ segments: [] })],
    ["two segments", envelope({ segments: [segment, segment] })],
    ["segments as text", envelope({ segments: segment })],
    ["a segment as a number", envelope({ segments: [1] })],
    ["base64 without padding", envelope({ document: "QUI" })],
    ["base64 with extra padding", envelope({ document: "QUI==" })],
    ["url-safe base64", envelope({ document: "-_-_" })],
    ["base64 with a line break", envelope({ document: "QUJD\nREVG" })],
    ["base64 with a space", envelope({ document: "QUJD REVG" })],
    ["non-canonical trailing bits", envelope({ document: "QR==" })],
    ["a revision as text", envelope({ baseRevision: "0" })],
    ["a revision null", envelope({ baseRevision: null })],
    ["a transaction id as a number", envelope({ clientTransactionId: 7 })],
    ["a document id as a number", envelope({ documentId: 7 })],
    ["an array", "[]"],
    ["not JSON", "documentId"],
    ["an empty body", ""],
    ["a byte order mark", `﻿${JSON.stringify(GOOD_BODY)}`],
  ])("%s is 422 invalid and never reaches the service", async (_name, body) => {
    const answer = await post(body);
    expect(answer.status).toBe(422);
    expect(JSON.parse(answer.body)).toEqual({ status: "invalid" });
    expect(calls).toEqual([]);
  });

  it("an empty document is well-formed base64: the envelope passes it and the service refuses it", async () => {
    await post(envelope({ document: "" }));
    expect(calls[0]?.request.document.byteLength).toBe(0);
  });

  it("C9: a base64 text of millions of characters is a closed answer, never 500", async () => {
    // Under the body limit; the grouped pattern of Ductus threw here (V8 backtracking).
    const valid = await post(envelope({ document: "A".repeat(4_600_000) }));
    expect(valid.status).toBe(404);
    expect(calls).toHaveLength(1);
    const broken = await post(envelope({ document: `${"A".repeat(5_000_000)}-` }));
    expect(broken.status).toBe(422);
    expect(JSON.parse(broken.body)).toEqual({ status: "invalid" });
    expect(calls).toHaveLength(1);
  });

  it("C10: of a repeated key the last one counts, as in Ductus", async () => {
    const body = JSON.stringify(GOOD_BODY).replace("{", '{"baseRevision":99,');
    await post(body);
    expect(calls[0]?.request.baseRevision).toBe(GOOD_BODY.baseRevision);
  });
});

describe("E, F4. failures of the service", () => {
  it("a throw is 503 repository; the record has the class only, never the message or token", async () => {
    const lines: string[] = [];
    const stderr = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
    try {
      next = () => Promise.reject(new Error(`kanarinac ${TOKEN}`));
      const answer = await post(JSON.stringify(GOOD_BODY));
      expect(answer.status).toBe(503);
      expect(answer.head["retry-after"]).toBe("5");
      expect(JSON.parse(answer.body)).toEqual({ status: "unavailable", stage: "repository" });
      expect(answer.body).not.toContain("kanarinac");
    } finally {
      stderr.mockRestore();
    }
    const records = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records).toEqual([
      {
        event: "server_error",
        where: "route",
        errorClass: expect.any(String),
        requestId: expect.any(String),
        route: "evidence.commit.post",
      },
    ]);
    for (const line of lines) {
      expect(line).not.toContain("kanarinac");
      expect(line).not.toContain(TOKEN);
    }
  });

  it.each(["context", "storage", "repository", "signing"])(
    "unavailable at %s is 503 with that stage and never its code",
    async (stage) => {
      next = async () => ({ status: "unavailable", stage, code: "storage_conflict" }) as never;
      const answer = await post(JSON.stringify(GOOD_BODY));
      expect(answer.status).toBe(503);
      expect(JSON.parse(answer.body)).toEqual({ status: "unavailable", stage });
    },
  );

  it.each([
    ["unauthenticated", 401],
    ["document_mismatch", 422],
    ["too_large", 413],
  ] as const)("%s from the service is %i", async (status, code) => {
    next = async () => ({ status }) as EvidenceCommitRequestOutcome;
    const answer = await post(JSON.stringify(GOOD_BODY));
    expect(answer.status).toBe(code);
    expect(JSON.parse(answer.body)).toEqual({ status });
  });
});

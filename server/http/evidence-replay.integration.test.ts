// DAN-818, attack plan ductura/server#136 A, B, C and E: the replay route on a
// real server with the real pipeline and router, over a scripted database
// (the two replay RPCs) and an in-memory store. Every vector of
// evidence.replay.post is sent as its bytes and answered as the vector says
// (403 by status only: pipeline step 7, docs/vs1-rute.md). The real database
// is tests/db/evidence-replay-route.integration.test.ts. Every token,
// identifier and text is invented.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { connect } from "node:net";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { ActorReader, ActorTransaction, WithActor } from "../database/index.ts";
import { InMemoryEvidencePayloadStore } from "../external/storage/index.ts";

import { createDatabases } from "./databases.ts";
import { createEvidenceReplayRoute } from "./evidence-replay.ts";
import { createLayers } from "./pipeline.ts";
import { type Running, startServer } from "./start.ts";

type Vector = {
  name: string;
  request: { headers: Record<string, string>; body?: unknown; rawBody?: string };
  response: { status: number; headers: Record<string, string>; body: Record<string, unknown> };
};
const read = (name: string) =>
  JSON.parse(
    readFileSync(new URL(`../contracts/vectors/${name}.json`, import.meta.url), "utf8"),
  ) as { vectors: Vector[] };
const { vectors } = read("evidence.replay.post");
const FIRST = vectors.find((v) => v.name === "first-page")!;
const ORIGIN = FIRST.request.headers.origin!;
const TOKEN = "izmisljeni-token-evidencije-000000000000001";
const INSTITUTION = "11111111-1111-4111-8111-111111111111";
const PACKAGE = "paket-izmisljeni-zv-1";
const DOC = "dokument-izmisljeni-zv-1";
const page = FIRST.response.body as { segments: string[]; startDocument: string };
const SEGMENT = page.segments[0]!;
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const HASH = sha(SEGMENT);

type Row = Record<string, unknown>;
// The source row per document: what app.read_replay_source answers for this session.
let sources: Record<string, Row | Error> = {};
let checkpoints: Row[] = [];
const queries: { text: string; values: readonly unknown[] | undefined; token: unknown }[] = [];
// A row of app.read_replay_source; its column names are the database's, which
// only server/database names in code, so the row is built from pairs here.
const found = (hashes: string[]): Row =>
  Object.fromEntries([
    ["outcome", "found"],
    ["institution_id", INSTITUTION],
    ["evidence_package_id", PACKAGE],
    ["segment_hashes", hashes],
  ]);
const withActor = (async (token, fn) => {
  const tx: ActorTransaction = {
    async query(text, values) {
      queries.push({ text, values, token });
      if (text.includes("read_replay_checkpoints")) {
        const asked = (values?.[1] ?? []) as string[];
        const rows = checkpoints.filter((r) => asked.includes(r.content_hash as string));
        return { rows: rows as never[], rowCount: rows.length };
      }
      const row = sources[String(values?.[0])] ?? { outcome: "not_found" };
      if (row instanceof Error) throw row;
      return { rows: [row] as never[], rowCount: 1 };
    },
  };
  return fn(tx);
}) as WithActor;
const actors: ActorReader = {
  currentActor: () => Promise.reject(new Error("replay does not ask the session first")),
  currentActorWithInstitution: () => Promise.reject(new Error("not used")),
};
const store = new InMemoryEvidencePayloadStore();
const reads = vi.spyOn(store, "readImmutable");

function reset() {
  queries.length = 0;
  reads.mockClear();
  checkpoints = [{ content_hash: sha(page.startDocument), body: page.startDocument }];
  sources = {
    [DOC]: found([HASH]),
    "dokument-izmisljeni-zv-2": found([]),
    "dokument-izmisljeni-zv-4": { outcome: "unavailable" },
    // Listed, but its object is not in the institution's storage.
    "dokument-izmisljeni-zv-5": found(["c".repeat(64)]),
  };
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
  return `POST /api/v1/evidence/replay HTTP/1.1\r\n${lines.join("\r\n")}\r\n\r\n${body}`;
}
const post = (body: string) => send(request(FIRST.request.headers, body));

let server: Running;
beforeAll(async () => {
  await store.putImmutable({
    institutionId: INSTITUTION,
    evidencePackageId: PACKAGE,
    segmentHash: HASH,
    canonicalPayload: SEGMENT,
  });
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    layers: createLayers({ expectedOrigin: ORIGIN }),
    databases: createDatabases(),
    routes: [
      createEvidenceReplayRoute({
        actorReader: actors,
        withActor,
        payloads: store,
        timeoutMs: 300,
      }),
    ],
  });
});
afterAll(async () => server.close());
beforeEach(reset);

describe("every vector of evidence.replay.post", () => {
  it.each(vectors.map((v) => [v.name, v] as const))("%s", async (_name, v) => {
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
    // A page goes out as the JCS text the vector is: the same bytes.
    if (v.response.status === 200) expect(answer.body).toBe(JSON.stringify(v.response.body));
  });
});

describe("A. access comes from the session and the database only", () => {
  it("the token goes only to withActor; the RPC gets only the document id", async () => {
    await post(JSON.stringify({ documentId: DOC, from: 0 }));
    expect(queries.map((q) => q.token)).toEqual([TOKEN, TOKEN]);
    expect(queries[0]?.values).toEqual([DOC]);
    for (const q of queries) expect(JSON.stringify(q.values)).not.toContain(TOKEN);
  });

  it("A2: a work the source does not find is 404 and the storage is never read", async () => {
    const answer = await post(JSON.stringify({ documentId: "dokument-tudji-1", from: 0 }));
    expect(answer.status).toBe(404);
    expect(reads).not.toHaveBeenCalled();
  });

  it("A7: a foreign work with a head is 404, never 409", async () => {
    const head = { segmentHash: "0".repeat(64), segmentCount: 9 };
    const answer = await post(JSON.stringify({ documentId: "dokument-tudji-1", from: 3, head }));
    expect(answer.status).toBe(404);
  });

  it("A4: the storage of the institution named by the row, never one from the request", async () => {
    await post(JSON.stringify({ documentId: DOC, from: 0 }));
    expect(reads.mock.calls.map(([input]) => input.institutionId)).toEqual([INSTITUTION]);
  });

  it("A6: ZD401 from the database is 401", async () => {
    sources[DOC] = Object.assign(new Error("izmisljeno"), { code: "ZD401" });
    const answer = await post(JSON.stringify({ documentId: DOC, from: 0 }));
    expect(answer.status).toBe(401);
    expect(JSON.parse(answer.body)).toEqual({ status: "unauthenticated" });
  });
});

describe("B. the closed body", () => {
  const head = `{"segmentHash":"${HASH}","segmentCount":1}`;
  it.each([
    ["a later page without its head", `{"documentId":"${DOC}","from":1}`],
    ["a first page with a head", `{"documentId":"${DOC}","from":0,"head":${head}}`],
    ["from -1", `{"documentId":"${DOC}","from":-1}`],
    ["from 1.5", `{"documentId":"${DOC}","from":1.5,"head":${head}}`],
    ["from as text", `{"documentId":"${DOC}","from":"0"}`],
    ["from 2^53", `{"documentId":"${DOC}","from":9007199254740992,"head":${head}}`],
    ["from 1e400", `{"documentId":"${DOC}","from":1e400,"head":${head}}`],
    ["an uppercase head hash", `{"documentId":"${DOC}","from":1,"head":${head.toUpperCase()}}`],
    [
      "a head count of 0",
      `{"documentId":"${DOC}","from":1,"head":{"segmentHash":"${HASH}","segmentCount":0}}`,
    ],
    [
      "a head with a third key",
      `{"documentId":"${DOC}","from":1,"head":{"segmentHash":"${HASH}","segmentCount":1,"x":1}}`,
    ],
    ["a null head", `{"documentId":"${DOC}","from":1,"head":null}`],
    ["an institution", `{"documentId":"${DOC}","from":0,"institutionId":"${INSTITUTION}"}`],
    ["a role", `{"documentId":"${DOC}","from":0,"role":"teacher"}`],
    ["__proto__", `{"documentId":"${DOC}","from":0,"__proto__":{"x":1}}`],
    ["a document id as a number", '{"documentId":1,"from":0}'],
    ["a BOM", `﻿{"documentId":"${DOC}","from":0}`],
    ["an array", `["${DOC}",0]`],
    ["not JSON", "documentId"],
    ["an empty body", ""],
  ])("%s is 422 invalid and never reaches the database", async (_name, body) => {
    const answer = await post(body);
    expect(answer.status).toBe(422);
    expect(JSON.parse(answer.body)).toEqual({ status: "invalid" });
    expect(queries).toEqual([]);
  });

  it.each(["", "doc ", "a\tb", "d".repeat(257)])(
    "B11: the id %j cannot exist: 404 and the database is never asked",
    async (documentId) => {
      const answer = await post(JSON.stringify({ documentId, from: 0 }));
      expect(answer.status).toBe(404);
      expect(queries).toEqual([]);
    },
  );
});

describe("C and E. failures are whole and never look like absence", () => {
  it("C14: an object that does not hash to its listed hash is 503 storage, never a page", async () => {
    sources[DOC] = found(["d".repeat(64)]);
    await store.putImmutable({
      institutionId: INSTITUTION,
      evidencePackageId: PACKAGE,
      segmentHash: "d".repeat(64),
      canonicalPayload: SEGMENT,
    });
    const answer = await post(JSON.stringify({ documentId: DOC, from: 0 }));
    expect(answer.status).toBe(503);
    expect(JSON.parse(answer.body)).toEqual({ status: "unavailable", stage: "storage" });
  });

  it("C18: no checkpoint for the start is 503 context", async () => {
    checkpoints = [];
    const answer = await post(JSON.stringify({ documentId: DOC, from: 0 }));
    expect(answer.status).toBe(503);
    expect(JSON.parse(answer.body)).toEqual({ status: "unavailable", stage: "context" });
  });

  it("E23, E24: a throw is 503 context; the record has the class only, never the message or token", async () => {
    sources[DOC] = new Error(`kanarinac ${TOKEN}`);
    const lines: string[] = [];
    const stderr = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
    let answer: Answer;
    try {
      answer = await post(JSON.stringify({ documentId: DOC, from: 0 }));
    } finally {
      stderr.mockRestore();
    }
    expect(answer.status).toBe(503);
    expect(answer.head["retry-after"]).toBe("5");
    expect(JSON.parse(answer.body)).toEqual({ status: "unavailable", stage: "context" });
    expect(answer.body).not.toContain("kanarinac");
    for (const line of lines) {
      expect(line).not.toContain("kanarinac");
      expect(line).not.toContain(TOKEN);
    }
  });
});

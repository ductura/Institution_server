// POST /api/v1/submission on a real server with the real pipeline, over a
// fake submission port (B-12 step 4b2): every vector of the contract a socket
// can reach, the closed mapping of every outcome onto the wire, and the body
// check before the port (Ductus submission-route.ts at 078c780). The port
// itself is Ductus submitWork, not mounted yet (submission.ts). All values
// are invented.
import { readFileSync } from "node:fs";
import { connect } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import type { ActorReader } from "../database/index.ts";

import { createDatabases } from "./databases.ts";
import { createLayers } from "./pipeline.ts";
import { type Running, startServer } from "./start.ts";
import { createSubmissionRoute, type SubmissionOutcome, submissionAnswer } from "./submission.ts";

type Vector = {
  name: string;
  request: { headers: Record<string, string>; body?: unknown; rawBody?: string };
  response: { status: number; body: Record<string, unknown>; headers?: Record<string, string> };
};
const VECTORS = (
  JSON.parse(
    readFileSync(
      new URL("../contracts/vectors/submission.submit.post.json", import.meta.url),
      "utf8",
    ),
  ) as { vectors: Vector[] }
).vectors;
const ORIGIN = "https://ductura.example.invalid";
const PATH = "/api/v1/submission";

let server: Running | undefined;
const calls: unknown[][] = [];
const activity: string[] = [];
let outcome: SubmissionOutcome | (() => never) = { status: "invalid" };

async function start() {
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    layers: createLayers({ expectedOrigin: ORIGIN }),
    databases: createDatabases(),
    routes: [
      createSubmissionRoute({
        submit: async (token, input) => {
          calls.push([token, input]);
          return typeof outcome === "function" ? outcome() : outcome;
        },
        actors: {} as ActorReader,
        recordActivity: async (token) => activity.push(token),
        timeoutMs: 300,
      }),
    ],
  });
}
afterEach(async () => {
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

// A short body under a longer Content-Length is a wait or a client gone on a
// real socket; the reader's own 400 is mutation-request.test.ts.

/** The outcome of submitWork each vector that reaches the port stands for. */
function outcomeOf(v: Vector): SubmissionOutcome | undefined {
  const body = v.response.body;
  switch (v.name) {
    case "submitted":
    case "submitted-after-deadline":
      return { status: "submitted", receipt: body.receipt };
    case "not-found":
      return { status: "not_found" };
    case "blocked-no-evidence":
    case "blocked-record-mismatch":
      return { status: "blocked", reason: body.reason as "no_evidence" };
    case "stale-revision":
      return { status: "stale_revision", currentRevision: body.currentRevision as number };
    case "already-requested":
      return { status: "already_requested", revision: body.revision as number };
    case "not-acknowledged":
      return { status: "not_acknowledged" };
    case "not-open":
      return { status: "not_open" };
    case "unavailable-signing":
    case "unavailable-verification":
      return { status: "unavailable", stage: body.stage as "signing", code: "izmisljeno" };
    default:
      return undefined;
  }
}

describe("every vector a socket can reach", () => {
  it.each(VECTORS.map((v) => [v.name, v] as const))("%s", async (_name, v) => {
    const arranged = outcomeOf(v);
    outcome = arranged ?? { status: "invalid" };
    await start();
    const body = v.request.rawBody ?? JSON.stringify(v.request.body);
    const got = await send(raw(PATH, Object.entries(v.request.headers), body));
    expect(got.status).toBe(v.response.status);
    if (v.name === "bad-request") return; // Node's parser answers a negative length itself.
    expect(got.head["cache-control"]).toBe("no-store");
    // Pipeline step 7 answers the problem of its reason, as on every evidence
    // route (evidence-commit.integration.test.ts); the status is the contract's.
    if (v.name.startsWith("forbidden")) return;
    for (const [name, value] of Object.entries(v.response.headers ?? {})) {
      expect(got.head[name]).toBe(value);
    }
    expect(JSON.parse(got.body)).toEqual(v.response.body);
    const token = v.request.headers.cookie?.slice("__Host-ductus_session=".length);
    const sent = v.request.body as { documentId: string; revision: number } | undefined;
    expect(calls).toEqual(arranged === undefined ? [] : [[token, sent]]);
    expect(activity).toEqual(got.status === 200 ? [token] : []);
  });
});

describe("the closed mapping", () => {
  it("a status it does not name, and a port that throws, are 503 submission", async () => {
    expect(submissionAnswer({ status: "accepted" } as unknown as SubmissionOutcome)).toEqual({
      status: 503,
      body: { status: "unavailable", stage: "submission" },
      headers: { "retry-after": "5" },
    });
    outcome = () => {
      throw new Error("izmišljeno");
    };
    await start();
    const v = VECTORS.find((x) => x.name === "submitted")!;
    const got = await send(
      raw(PATH, Object.entries(v.request.headers), JSON.stringify(v.request.body)),
    );
    expect([got.status, JSON.parse(got.body)]).toEqual([
      503,
      { status: "unavailable", stage: "submission" },
    ]);
    expect(activity).toEqual([]);
  });

  it("a stage outside the contract or an unknown block reason is 500, never another answer", async () => {
    const v = VECTORS.find((x) => x.name === "submitted")!;
    for (const answer of [
      { status: "unavailable", stage: "izmisljeno", code: "x" },
      { status: "blocked", reason: "izmisljeno" },
      { status: "already_requested", revision: 0 },
    ] as unknown as SubmissionOutcome[]) {
      outcome = answer;
      await start();
      const got = await send(
        raw(PATH, Object.entries(v.request.headers), JSON.stringify(v.request.body)),
      );
      expect(got.status).toBe(500);
      await server?.close();
      server = undefined;
    }
  });
});

describe("the body before the port", () => {
  const v = VECTORS.find((x) => x.name === "submitted")!;
  const headers = Object.entries(v.request.headers);
  it.each([
    ["an empty document id", '{"documentId":"","revision":1}'],
    ["a revision as text", '{"documentId":"rad","revision":"1"}'],
    ["a fractional revision", '{"documentId":"rad","revision":1.5}'],
    ["a revision past 2^53", '{"documentId":"rad","revision":9007199254740992}'],
    ["a time from the client", '{"documentId":"rad","revision":1,"requestedAt":"2026-11-16"}'],
    ["a hash from the client", '{"documentId":"rad","revision":1,"artifactSha256":"00"}'],
    ["one key", '{"documentId":"rad"}'],
    ["an array", '["rad",1]'],
  ])("%s is 422 invalid without a call", async (_name, text) => {
    await start();
    const got = await send(raw(PATH, headers, text));
    expect([got.status, JSON.parse(got.body)]).toEqual([422, { status: "invalid" }]);
    expect(calls).toEqual([]);
  });

  it("revision 0 reaches the port (the database answers no_evidence)", async () => {
    outcome = { status: "blocked", reason: "no_evidence" };
    await start();
    expect((await send(raw(PATH, headers, '{"documentId":"rad","revision":0}'))).status).toBe(409);
    expect(calls).toHaveLength(1);
  });
});

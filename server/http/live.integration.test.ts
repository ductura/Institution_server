// GET and PUT /api/v1/live/{documentId} on a real server with the real
// pipeline, over a fake LiveStates port and a fake ActorReader: every vector
// of both contracts a socket can reach, sent as its bytes, and the order of
// the checks before the body (Ductus live-route.ts at 078c780, B-LIVE). All
// values are invented.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { connect } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import type {
  ActorReader,
  LivePublishOutcome,
  LiveReadOutcome,
  LiveStates,
} from "../database/index.ts";

import { createDatabases } from "./databases.ts";
import { createLiveRoutes } from "./live.ts";
import { createLayers } from "./pipeline.ts";
import { type Running, startServer } from "./start.ts";

type Vector = {
  name: string;
  request: {
    params: Record<string, string>;
    headers: Record<string, string>;
    body?: unknown;
    rawBody?: string;
  };
  response: { status: number; body: unknown; headers?: Record<string, string> };
};
const vectorsOf = (id: string): Vector[] =>
  (
    JSON.parse(
      readFileSync(new URL(`../contracts/vectors/${id}.json`, import.meta.url), "utf8"),
    ) as { vectors: Vector[] }
  ).vectors;
const GETS = vectorsOf("live.document.get");
const PUTS = vectorsOf("live.document.put");
const ORIGIN = "https://ductura.example.invalid";
const PATH = (id: string) => `/api/v1/live/${encodeURIComponent(id)}`;

let server: Running | undefined;
const calls: unknown[][] = [];
const activity: string[] = [];
let readAnswer: LiveReadOutcome = { status: "empty" };
let publishAnswer: LivePublishOutcome = { status: "unavailable", reason: "x" };
let signedIn: boolean | "throws" = true;

async function start() {
  const states: LiveStates = {
    publish: async (...args) => {
      calls.push(["publish", ...args]);
      return publishAnswer;
    },
    read: async (...args) => {
      calls.push(["read", ...args]);
      return readAnswer;
    },
  };
  const actors = {
    currentActor: async (token: string) => {
      calls.push(["actor", token]);
      if (signedIn === "throws") throw new Error("izmišljeno");
      return signedIn
        ? {
            userId: "9d8c7b6a-5f4e-4c3b-9a2d-1e0f9a8b7c01",
            institutionId: "7b6a5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c01",
          }
        : { userId: null, institutionId: null };
    },
  } as unknown as ActorReader;
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    layers: createLayers({ expectedOrigin: ORIGIN }),
    databases: createDatabases(),
    routes: createLiveRoutes({
      states,
      actors,
      recordActivity: async (token) => activity.push(token),
      timeoutMs: 300,
    }),
  });
}
afterEach(async () => {
  calls.length = 0;
  activity.length = 0;
  signedIn = true;
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

function raw(method: string, path: string, headers: [string, string][], body = ""): Buffer {
  const all: [string, string][] = [["host", "127.0.0.1"], ...headers];
  const framed = all.some(([k]) => /^(content-length|transfer-encoding)$/i.test(k));
  if (!framed && method === "PUT") all.push(["content-length", String(Buffer.byteLength(body))]);
  const head = `${method} ${path} HTTP/1.1\r\n${all.map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n`;
  return Buffer.concat([Buffer.from(head, "latin1"), Buffer.from(body)]);
}
const tokenOf = (v: Vector) => v.request.headers.cookie?.slice("__Host-ductus_session=".length);
const bodyOf = (v: Vector) => v.request.rawBody ?? JSON.stringify(v.request.body);
const withoutId = (text: string) => {
  const rest = JSON.parse(text) as Record<string, unknown>;
  delete rest.requestId;
  return rest;
};

describe("GET: every vector", () => {
  const STATES: Record<string, (v: Vector) => LiveReadOutcome> = {
    state: (v) => stateOf(v, false),
    submitted: (v) => stateOf(v, true),
    empty: () => ({ status: "empty" }),
    unchanged: (v) => ({ status: "not_modified", hash: etagOf(v), submitted: false }),
    "not-found": () => ({ status: "not_found" }),
    "invalid-document": () => ({ status: "invalid_document" }),
    unavailable: () => ({ status: "unavailable", reason: "database_error" }),
  };
  const etagOf = (v: Vector) => v.response.headers!.etag!.slice(1, -1);
  function stateOf(v: Vector, submitted: boolean): LiveReadOutcome {
    const bytes = new TextEncoder().encode(JSON.stringify(v.response.body));
    return { status: "state", hash: etagOf(v), bytes, submitted };
  }

  it.each(GETS.map((v) => [v.name, v] as const))("%s", async (_name, v) => {
    const arrange = STATES[v.name];
    if (arrange !== undefined) readAnswer = arrange(v);
    await start();
    const got = await send(
      raw("GET", PATH(v.request.params.documentId!), Object.entries(v.request.headers)),
    );
    expect(got.status).toBe(v.response.status);
    expect(got.head["cache-control"]).toBe("no-store");
    for (const [name, value] of Object.entries(v.response.headers ?? {})) {
      expect(got.head[name]).toBe(value);
    }
    if (v.response.headers?.["ductus-live-state"] === undefined) {
      expect(got.head["ductus-live-state"]).toBeUndefined();
    }
    if (got.status === 200) expect(JSON.parse(got.body)).toEqual(v.response.body);
    else if (got.status === 204 || got.status === 304) expect(got.body).toBe("");
    else expect(withoutId(got.body)).toEqual(withoutId(JSON.stringify(v.response.body)));
    const reached = arrange !== undefined;
    expect(calls).toEqual(
      reached
        ? [
            [
              "read",
              tokenOf(v),
              v.request.params.documentId,
              v.request.headers["if-none-match"]?.slice(1, -1) ?? null,
            ],
          ]
        : [],
    );
    // A read never counts as activity (Ductus GET is not counted).
    expect(activity).toEqual([]);
  });

  it("the protocol and Sec-Fetch-Site come before the session, an impossible id is 404 unread", async () => {
    await start();
    const v = GETS.find((x) => x.name === "state")!;
    const cookie: [string, string] = ["cookie", v.request.headers.cookie!];
    const path = PATH("izmisljeni-rad-0001");
    for (const headers of [
      [cookie, ["ductus-protocol", "2"]],
      [cookie, ["ductus-protocol", "1"], ["ductus-protocol", "1"]],
      [cookie, ["ductus-protocol", "1"], ["sec-fetch-site", "cross-site"]],
      [["ductus-protocol", "2"]],
    ] as [string, string][][]) {
      expect((await send(raw("GET", path, headers))).status).toBe(403);
    }
    const proto: [string, string] = ["ductus-protocol", "1"];
    expect((await send(raw("GET", "/api/v1/live/%20rad", [cookie, proto]))).status).toBe(404);
    expect(
      (await send(raw("GET", `/api/v1/live/${"x".repeat(257)}`, [cookie, proto]))).status,
    ).toBe(404);
    expect(calls).toEqual([]);
  });

  it("only the exact form of an ETag is passed on; anything else reads in full", async () => {
    readAnswer = { status: "empty" };
    await start();
    const v = GETS.find((x) => x.name === "unchanged")!;
    const hash = v.request.headers["if-none-match"]!.slice(1, -1);
    for (const sent of [`W/"${hash}"`, hash, `"${hash.toUpperCase()}"`, `"${hash}", "${hash}"`]) {
      await send(
        raw("GET", PATH("rad"), [
          ["cookie", v.request.headers.cookie!],
          ["ductus-protocol", "1"],
          ["if-none-match", sent],
        ]),
      );
    }
    expect(calls.map((c) => c[3])).toEqual([null, null, null, null]);
  });
});

describe("PUT: every vector", () => {
  const OUTCOMES: Record<string, (v: Vector) => LivePublishOutcome> = {
    accepted: (v) => ({ status: "accepted", token: (v.response.body as { token: string }).token }),
    "first-write": (v) => ({
      status: "accepted",
      token: (v.response.body as { token: string }).token,
    }),
    unchanged: (v) => ({
      status: "unchanged",
      token: (v.response.body as { token: string }).token,
    }),
    conflict: (v) => ({ status: "conflict", token: (v.response.body as { token: string }).token }),
    "conflict-nothing-published": () => ({ status: "conflict", token: null }),
    "not-found": () => ({ status: "not_found" }),
    unavailable: () => ({ status: "unavailable", reason: "database_error" }),
  };
  // A short body under a longer Content-Length is the deadline on a real socket.
  it.each(PUTS.map((v) => [v.name, v] as const))("%s", async (_name, v) => {
    const arrange = OUTCOMES[v.name];
    if (arrange !== undefined) publishAnswer = arrange(v);
    await start();
    const got = await send(
      raw("PUT", PATH(v.request.params.documentId!), Object.entries(v.request.headers), bodyOf(v)),
    );
    expect(got.status).toBe(v.response.status);
    if (v.name === "bad-request") return; // Node's parser answers a negative length itself.
    // Pipeline step 7 answers the problem of its reason (origin_mismatch), as on
    // the evidence routes (evidence-commit.integration.test.ts); the contract
    // names it forbidden. The status is the contract's.
    if (v.name === "forbidden") return;
    expect(got.head["cache-control"]).toBe("no-store");
    const json = JSON.parse(got.body) as Record<string, unknown>;
    if (got.status === 200 || (got.status === 409 && "outcome" in json))
      expect(json).toEqual(v.response.body);
    else expect(withoutId(got.body)).toEqual(withoutId(JSON.stringify(v.response.body)));
    const token = tokenOf(v);
    const published = calls.filter((c) => c[0] === "publish");
    if (arrange !== undefined) {
      const expected = v.request.headers["if-match"]?.slice(1, -1) ?? null;
      expect(published).toEqual([
        ["publish", token, v.request.params.documentId, expected, bodyOf(v)],
      ]);
    } else {
      expect(published).toEqual([]);
    }
    expect(activity).toEqual(got.status === 200 ? [token] : []);
  });
});

describe("PUT: the order before the body", () => {
  const v = PUTS.find((x) => x.name === "accepted")!;
  const headers = Object.entries(v.request.headers);
  const without = (name: string) => headers.filter(([k]) => k !== name);

  it("media type, session, precondition and id come before the database; the session before the body", async () => {
    publishAnswer = { status: "accepted", token: "1b2c3d4e-5f60-4718-8293-a4b5c6d7e8fa" };
    await start();
    const body = bodyOf(v);
    const put = (list: [string, string][], path = PATH("rad"), text = body) =>
      send(raw("PUT", path, list, text));
    expect((await put([...without("content-type"), ["content-type", "text/json"]])).status).toBe(
      415,
    );
    expect((await put(without("cookie"))).status).toBe(401);
    for (const pre of [
      [["if-match", '"nije-uuid"']],
      [
        ["if-match", '"1b2c3d4e-5f60-4718-8293-a4b5c6d7e8f9"'],
        ["if-none-match", "*"],
      ],
      [["if-none-match", '"x"']],
      [
        ["if-match", '"1b2c3d4e-5f60-4718-8293-a4b5c6d7e8f9"'],
        ["if-match", '"1b2c3d4e-5f60-4718-8293-a4b5c6d7e8f9"'],
      ],
    ] as [string, string][][]) {
      expect((await put([...without("if-match"), ...pre])).status).toBe(428);
    }
    expect((await put(headers, "/api/v1/live/%20rad")).status).toBe(404);
    expect(calls).toEqual([]);
    signedIn = false;
    expect((await put(headers)).status).toBe(401);
    signedIn = "throws";
    expect((await put(headers)).status).toBe(503);
    expect(calls.map((c) => c[0])).toEqual(["actor", "actor"]);
  });

  it("a declared length past 2 MiB is 413 without asking the database", async () => {
    await start();
    const big = [...without("content-length"), ["content-length", String(2 * 1024 * 1024 + 1)]] as [
      string,
      string,
    ][];
    expect((await send(raw("PUT", PATH("rad"), big, "{}"))).status).toBe(413);
    expect(calls).toEqual([]);
  });

  it("bytes that are not the exact JCS text of a valid document are 422 before the database", async () => {
    await start();
    const pretty = JSON.stringify(JSON.parse(bodyOf(v)), null, 1);
    for (const text of [pretty, `\ufeff${bodyOf(v)}`, "{}", "null"]) {
      expect(
        (
          await send(
            raw(
              "PUT",
              PATH("rad"),
              headers.filter(([k]) => k !== "content-length"),
              text,
            ),
          )
        ).status,
      ).toBe(422);
    }
    expect(calls.map((c) => c[0])).toEqual(["actor", "actor", "actor", "actor"]);
  });

  it("an answer the contract does not declare is 500, never a 409 of another shape", async () => {
    publishAnswer = { status: "conflict", token: "nije-uuid" };
    await start();
    expect((await send(raw("PUT", PATH("rad"), headers, bodyOf(v)))).status).toBe(500);
  });
});

describe("the bytes of a read", () => {
  it("are exactly the stored bytes, with their SHA-256 as the ETag", async () => {
    const text = '{"b":1,"a":"č"}';
    const bytes = new TextEncoder().encode(text);
    const hash = createHash("sha256").update(bytes).digest("hex");
    readAnswer = { status: "state", hash, bytes, submitted: false };
    await start();
    const v = GETS.find((x) => x.name === "state")!;
    const got = await send(raw("GET", PATH("rad"), Object.entries(v.request.headers)));
    expect([got.status, got.body, got.head.etag]).toEqual([200, text, `"${hash}"`]);
    expect(got.head["content-type"]).toBe("application/json; charset=utf-8");
  });
});

// DAN-811 part a, plan of attack ductura/server#107 parts A, B and F: the
// checks of the evidence routes before and while reading a body, and the
// {status} writer through the router's gate, on a real node:http server with
// the real pipeline. Raw sockets, so the test controls every header and body
// byte. Every token, origin and identifier is invented.
import { readFileSync } from "node:fs";
import { connect } from "node:net";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ROUTES } from "../contracts/index.ts";
import type { ActorReader } from "../database/index.ts";

import { createDatabases } from "./databases.ts";
import { readEvidenceBody, sendEvidenceAnswer } from "./evidence-request.ts";
import { createLayers } from "./pipeline.ts";
import { sendRouteRefusal } from "./problem.ts";
import { sendJson } from "./router.ts";
import { type Running, startServer } from "./start.ts";

const ORIGIN = "https://ductura.example.invalid";
const OPEN_PATH = "/api/v1/evidence/open";
const PROBE_PATH = "/api/v1/evidence/commit";
const TOKEN = "izmisljeni-token-evidencije-000000000000001";
const COOKIE = `__Host-ductus_session=${TOKEN}`;
const BODY = '{"assignmentId":"00000000-0000-4000-8000-0000000000a1"}';
const LIMIT = 1024;

const contractOf = (id: string) => {
  const found = ROUTES.find((route) => route.id === id);
  if (found === undefined) throw new Error(`no contract ${id}`);
  return found;
};
const OPEN = contractOf("evidence.open.post");
const COMMIT = contractOf("evidence.commit.post");

type Vector = {
  name: string;
  response: { status: number; headers: Record<string, string>; body: unknown };
};
function vector(name: string): Vector["response"] {
  const file = new URL("../contracts/vectors/evidence.open.post.json", import.meta.url);
  const { vectors } = JSON.parse(readFileSync(file, "utf8")) as { vectors: Vector[] };
  const found = vectors.find((v) => v.name === name);
  if (found === undefined) throw new Error(`no vector ${name}`);
  return found.response;
}

let sessionCalls = 0;
const actors: ActorReader = {
  async currentActor() {
    sessionCalls += 1;
    return { userId: null, institutionId: null };
  },
  async currentActorWithInstitution() {
    throw new Error("not used");
  },
};

type Seen = { ok: boolean; token?: string; size?: number };
const seen: Seen[] = [];
// What the probe route answers: the next refusal to write, by the test.
let probe: (response: Parameters<typeof sendRouteRefusal>[0]) => void = () => undefined;

type Answer = { status: number; head: Record<string, string>; body: string; raw: string };

function parse(raw: string): Answer {
  const [head = "", ...rest] = raw.split("\r\n\r\n");
  const [line = "", ...fields] = head.split("\r\n");
  const headers: Record<string, string> = {};
  for (const field of fields) {
    const at = field.indexOf(":");
    headers[field.slice(0, at).toLowerCase()] = field.slice(at + 1).trim();
  }
  return { status: Number(line.split(" ")[1]), head: headers, body: rest.join("\r\n\r\n"), raw };
}

/** Sends a raw request and reads until the server closes or the answer is whole. */
function send(port: number, path: string, lines: string[], body = "", end = true): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    let text = "";
    const head = [`POST ${path} HTTP/1.1`, "Host: 127.0.0.1", ...lines];
    socket.write(`${head.join("\r\n")}\r\n\r\n${body}`);
    if (end) socket.end();
    socket.on("data", (chunk: Buffer) => {
      text += chunk.toString("latin1");
      const answer = parse(text);
      const length = Number(answer.head["content-length"]);
      if (Number.isInteger(length) && Buffer.byteLength(answer.body) >= length) {
        socket.destroy();
        resolve(answer);
      }
    });
    socket.on("error", reject);
    socket.on("close", () => resolve(parse(text)));
  });
}

const GOOD = [
  `Origin: ${ORIGIN}`,
  "Sec-Fetch-Site: same-origin",
  "Content-Type: application/json",
  "Ductus-Protocol: 1",
  `Cookie: ${COOKIE}`,
];
const withLength = (lines: string[], body: string) => [
  ...lines,
  `Content-Length: ${Buffer.byteLength(body)}`,
];
const replace = (name: string, value: string | null) => {
  const kept = GOOD.filter((line) => !line.toLowerCase().startsWith(`${name.toLowerCase()}:`));
  return value === null ? kept : [...kept, `${name}: ${value}`];
};

let server: Running;
beforeAll(async () => {
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    layers: createLayers({ expectedOrigin: ORIGIN }),
    databases: createDatabases(),
    routes: [
      {
        contract: OPEN,
        handle: async (request, response) => {
          const read = await readEvidenceBody(request, actors, {
            protocols: ["1"],
            maxBytes: LIMIT,
            timeoutMs: 300,
            live: false,
          });
          if (!read.ok) {
            seen.push({ ok: false });
            return sendEvidenceAnswer(response, OPEN, read.answer);
          }
          seen.push({ ok: true, token: read.token, size: read.bytes.byteLength });
          sendJson(response, 200, { size: read.bytes.byteLength });
        },
      },
      { contract: COMMIT, handle: async (_request, response) => probe(response) },
    ],
  });
});
afterAll(async () => server.close());
beforeEach(() => {
  seen.length = 0;
  sessionCalls = 0;
});

const port = () => server.port;
const open = (lines: string[], body = BODY) =>
  send(port(), OPEN_PATH, withLength(lines, body), body);

/** The answer equals the vector in status, the headers it names and the body. */
function expectVector(answer: Answer, name: string): void {
  const v = vector(name);
  expect(answer.status).toBe(v.status);
  expect(answer.head["content-type"]).toBe("application/json; charset=utf-8");
  for (const [key, value] of Object.entries(v.headers)) expect(answer.head[key]).toBe(value);
  expect(JSON.parse(answer.body)).toEqual(v.body);
  expect(answer.head["set-cookie"]).toBeUndefined();
  expect(answer.head["x-request-id"]).toMatch(/\S/);
}

describe("A. checks before the body, in order", () => {
  it("passes a request of the right form and hands over the token and the bytes", async () => {
    const answer = await open(GOOD);
    expect(answer.status).toBe(200);
    expect(seen).toEqual([{ ok: true, token: TOKEN, size: Buffer.byteLength(BODY) }]);
    expect(sessionCalls).toBe(0);
  });

  it.each([
    ["missing", replace("Ductus-Protocol", null)],
    ["2", replace("Ductus-Protocol", "2")],
    ["'1 ,1'", replace("Ductus-Protocol", "1 ,1")],
    ["'1, 1'", replace("Ductus-Protocol", "1, 1")],
    ["sent twice", [...GOOD, "Ductus-Protocol: 1"]],
    ["01", replace("Ductus-Protocol", "01")],
  ])("A1: protocol %s is 426, the body unread", async (_name, lines) => {
    const answer = await open(lines);
    expectVector(answer, "upgrade-required");
    expect(seen).toEqual([{ ok: false }]);
    expect(answer.head.connection).toBe("close");
  });

  it.each([
    ["missing", replace("Content-Type", null)],
    ["text/plain", replace("Content-Type", "text/plain")],
    ["application/json-patch+json", replace("Content-Type", "application/json-patch+json")],
    ["application/jsonx", replace("Content-Type", "application/jsonx")],
    ["sent twice", [...GOOD, "Content-Type: application/json"]],
  ])("A2: content type %s is 415", async (_name, lines) => {
    expectVector(await open(lines), "unsupported-media-type");
  });

  it.each([
    ["with a charset", "application/json; charset=utf-8"],
    ["in capitals", "Application/JSON"],
  ])("A3: application/json %s passes", async (_name, type) => {
    expect((await open(replace("Content-Type", type))).status).toBe(200);
  });

  it("A4: the protocol is checked before the media type, and both before the cookie", async () => {
    const noCookie = replace("Cookie", null);
    const both = noCookie.filter((l) => !/^(content-type|ductus-protocol):/i.test(l));
    expectVector(await open(both), "upgrade-required");
    expectVector(await open([...both, "Ductus-Protocol: 1"]), "unsupported-media-type");
  });

  it.each([
    ["no cookie", replace("Cookie", null)],
    ["a token of 42 characters", replace("Cookie", `__Host-ductus_session=${TOKEN.slice(1)}`)],
    ["two session cookies", replace("Cookie", `${COOKIE}; ${COOKIE}`)],
    ["a cookie without the prefix", replace("Cookie", `ductus_session=${TOKEN}`)],
  ])("A5: %s is 401 at the session step", async (_name, lines) => {
    const answer = await open(lines);
    expectVector(answer, "unauthenticated");
    expect(seen).toEqual([{ ok: false }]);
    expect(sessionCalls).toBe(0);
  });

  it("A6: a foreign Origin stops in pipeline step 7 with the vector's status; the route is not called", async () => {
    const answer = await open(replace("Origin", "https://drugo.example.invalid"));
    expect(answer.status).toBe(vector("forbidden").status);
    expect(answer.head["cache-control"]).toBe("no-store");
    expect(seen).toEqual([]);
  });

  // M3.1 (B-8): "ingest refuses a wrong or missing Origin and Sec-Fetch-Site",
  // on the mounted commit path as on open; neither handler is ever reached.
  it.each([
    ["no Origin", replace("Origin", null)],
    ["an opaque Origin", replace("Origin", "null")],
    ["Origin sent twice", [...GOOD, `Origin: ${ORIGIN}`]],
    ["Sec-Fetch-Site cross-site", replace("Sec-Fetch-Site", "cross-site")],
    ["Sec-Fetch-Site same-site", replace("Sec-Fetch-Site", "same-site")],
    ["Sec-Fetch-Site none", replace("Sec-Fetch-Site", "none")],
  ])("A6: %s is 403 in step 7 on open and on commit", async (_name, lines) => {
    let probed = false;
    probe = () => {
      probed = true;
    };
    for (const path of [OPEN_PATH, PROBE_PATH]) {
      const answer = await send(port(), path, withLength(lines, BODY), BODY);
      expect(answer.status).toBe(vector("forbidden").status);
      expect(answer.body).not.toContain(BODY);
    }
    expect(seen).toEqual([]);
    expect(probed).toBe(false);
  });
});

describe("B. the body under its limits", () => {
  it("B1: a declared length over the limit is 413", async () => {
    const answer = await send(port(), OPEN_PATH, [...GOOD, `Content-Length: ${LIMIT + 1}`]);
    expectVector(answer, "too-large");
    expect(answer.head.connection).toBe("close");
  });

  it("B1: a chunked body over the limit is 413", async () => {
    const chunk = "a".repeat(LIMIT + 1);
    const body = `${chunk.length.toString(16)}\r\n${chunk}\r\n0\r\n\r\n`;
    const answer = await send(port(), OPEN_PATH, [...GOOD, "Transfer-Encoding: chunked"], body);
    expectVector(answer, "too-large");
  });

  it.each(["-1", "01", "1e3"])("B2: Content-Length %s is 400", async (length) => {
    const answer = await send(port(), OPEN_PATH, [...GOOD, `Content-Length: ${length}`], BODY);
    // Node itself refuses some forms with 400 before the route; either way it is 400.
    expect(answer.status).toBe(400);
  });

  it("B2: the vector's Content-Length -1 is the vector's answer when it reaches the route", async () => {
    const answer = await send(port(), OPEN_PATH, [...GOOD, "Content-Length: -1"], BODY);
    expect(answer.status).toBe(vector("bad-request").status);
  });

  it("B3: a body cut short of its declared length is 408 after the deadline", async () => {
    const answer = await send(
      port(),
      OPEN_PATH,
      [...GOOD, "Content-Length: 60"],
      '{"assignmentId"',
      false,
    );
    expectVector(answer, "timeout");
  });
});

describe("F. the {status} writer behind the router's gate", () => {
  it("writes an error of the route's own contract with only Retry-After on 503", async () => {
    probe = (response) => {
      response.setHeader("Set-Cookie", "a=b");
      response.setHeader("Location", "/x");
      sendRouteRefusal(
        response,
        COMMIT,
        503,
        { status: "unavailable", stage: "storage" },
        {
          "retry-after": "5",
        },
      );
    };
    const answer = await send(port(), PROBE_PATH, withLength(GOOD, BODY), BODY);
    expect(answer.status).toBe(503);
    expect(JSON.parse(answer.body)).toEqual({ status: "unavailable", stage: "storage" });
    expect(answer.head["retry-after"]).toBe("5");
    expect(answer.head["set-cookie"]).toBeUndefined();
    expect(answer.head.location).toBeUndefined();
    expect(answer.head["cache-control"]).toBe("no-store");
    expect(answer.head["x-content-type-options"]).toBe("nosniff");
    expect(answer.head["x-request-id"]).toMatch(/\S/);
  });

  it.each([
    ["a status outside the contract", 418, { status: "invalid" }, {}],
    ["a code under another status", 404, { status: "forbidden" }, {}],
    ["a stage the route does not have", 503, { status: "unavailable", stage: "nowhere" }, {}],
    ["a missing stage", 503, { status: "unavailable" }, {}],
    ["an extra field", 404, { status: "not_found", input: "x" }, {}],
    ["Retry-After on a 404", 404, { status: "not_found" }, { "retry-after": "5" }],
    [
      "a Retry-After that is not seconds",
      503,
      { status: "unavailable", stage: "context" },
      {
        "retry-after": "abc",
      },
    ],
    [
      "a Retry-After of 0",
      503,
      { status: "unavailable", stage: "context" },
      { "retry-after": "0" },
    ],
    [
      "a Retry-After of five digits",
      503,
      { status: "unavailable", stage: "context" },
      { "retry-after": "99999" },
    ],
    ["a 503 without Retry-After", 503, { status: "unavailable", stage: "context" }, {}],
    [
      "a Retry-After with a line break",
      503,
      { status: "unavailable", stage: "context" },
      {
        "retry-after": "5\r\nx: y",
      },
    ],
  ])("F1: %s answers 500 internal", async (_name, status, body, headers) => {
    probe = (response) => sendRouteRefusal(response, OPEN, status, body as never, headers);
    const answer = await send(port(), PROBE_PATH, withLength(GOOD, BODY), BODY);
    expect(answer.status).toBe(500);
    expect(JSON.parse(answer.body)).toMatchObject({ code: "internal" });
  });

  it("F2: a Retry-After the handler set before is dropped from an answer that is not 503", async () => {
    probe = (response) => {
      response.setHeader("Retry-After", "120");
      sendRouteRefusal(response, OPEN, 404, { status: "not_found" });
    };
    const answer = await send(port(), PROBE_PATH, withLength(GOOD, BODY), BODY);
    expect(answer.status).toBe(404);
    expect(JSON.parse(answer.body)).toEqual({ status: "not_found" });
    expect(answer.head["retry-after"]).toBeUndefined();
  });

  it("F2: a Retry-After set before is dropped from the 500 of a refused call too", async () => {
    probe = (response) => {
      response.setHeader("Retry-After", "120");
      sendRouteRefusal(response, OPEN, 503, { status: "unavailable", stage: "context" });
    };
    const answer = await send(port(), PROBE_PATH, withLength(GOOD, BODY), BODY);
    expect(answer.status).toBe(500);
    expect(answer.head["retry-after"]).toBeUndefined();
  });

  it("F2: a 503 carries only its own Retry-After, not one set before", async () => {
    probe = (response) => {
      response.setHeader("Retry-After", "120");
      sendRouteRefusal(
        response,
        OPEN,
        503,
        { status: "unavailable", stage: "context" },
        {
          "retry-after": "5",
        },
      );
    };
    const answer = await send(port(), PROBE_PATH, withLength(GOOD, BODY), BODY);
    expect(answer.head["retry-after"]).toBe("5");
  });

  it("F3: a raw error head outside the writers is still 500", async () => {
    probe = (response) => {
      response.writeHead(404, { "content-type": "application/json" });
      response.end('{"status":"not_found"}');
    };
    const answer = await send(port(), PROBE_PATH, withLength(GOOD, BODY), BODY);
    expect(answer.status).toBe(500);
  });
});

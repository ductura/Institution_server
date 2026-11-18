// The rate limit on a real node:http server (S-1C.3, DAN-814 b; attack plan
// ductura/server#117): 429 too_many_requests with Retry-After and a locale
// key, a forged X-Forwarded-For does not get round it, a refused save sent
// again after Retry-After reaches the handler exactly once, and nothing
// pipelined behind a 429 runs. The clock is fake; requests go raw over a
// socket. Addresses are from the documentation ranges, tokens are invented.
import { connect } from "node:net";

import { createFakeClock } from "@ductura/test-fakes";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ROUTES } from "../contracts/index.ts";
import { redact } from "../log/index.ts";
import { sessionTokenFromCookie } from "../session/index.ts";
import {
  createRateLimiter,
  DEFAULT_RATE_LIMITS,
  parseTrustedProxies,
  type RateLimits,
} from "../traffic/index.ts";
import { createDatabases } from "./databases.ts";
import { createLayers } from "./pipeline.ts";
import type { RateLimitLog } from "./rate-limit-layer.ts";
import type { Route } from "./router.ts";
import { type Running, startServer } from "./start.ts";

const ORIGIN = "https://ductura.invalid";
const SAVE = "/api/v1/evidence/commit";
const READ = "/api/v1/student/assignments";
const TOKEN_A = "izmisljeni-token-a-000000000000000000000000".slice(0, 43);
const SESSION = "__Host-ductus_session";

const LIMITS: RateLimits = {
  login: { perIp: 2, perAccount: null },
  enroll: { perIp: 2, perAccount: 2 },
  save: { perIp: 2, perAccount: 2 },
  default: { perIp: 3, perAccount: 2 },
};

const contractOf = (id: string) => {
  const contract = ROUTES.find((route) => route.id === id);
  if (contract === undefined) throw new Error(`no contract ${id}`);
  return contract;
};

/** A save that stores each clientTransactionId once, as the contract's duplicate does. */
function savingRoute(stored: string[]): Route {
  return {
    contract: contractOf("evidence.commit.post"),
    handle: async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const { clientTransactionId } = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        clientTransactionId: string;
      };
      const status = stored.includes(clientTransactionId) ? "duplicate" : "committed";
      if (status === "committed") stored.push(clientTransactionId);
      response.writeHead(200, { "content-type": "application/json" }).end(`{"status":"${status}"}`);
    },
  };
}

function readRoute(counter: { n: number }): Route {
  return {
    contract: contractOf("student.assignments.get"),
    handle: async (_request, response) => {
      counter.n += 1;
      response.writeHead(200, { "content-type": "application/json" }).end("{}");
    },
  };
}

type Answer = { status: number; headers: Record<string, string>; body: string };

/** Raw HTTP/1.1 over one socket; several requests are pipelined in one write. */
function send(port: number, requests: string[]): Promise<Answer[]> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("error", reject);
    socket.on("close", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      const answers: Answer[] = [];
      for (const part of text.split(/(?=HTTP\/1\.1 \d{3} )/u).filter(Boolean)) {
        const [head = "", raw = ""] = part.split("\r\n\r\n");
        const [line = "", ...rest] = head.split("\r\n");
        const headers: Record<string, string> = {};
        for (const h of rest) {
          const i = h.indexOf(":");
          headers[h.slice(0, i).toLowerCase()] = h.slice(i + 1).trim();
        }
        const body =
          headers["transfer-encoding"] === "chunked" ? (raw.split("\r\n")[1] ?? "") : raw;
        answers.push({ status: Number(line.split(" ")[1]), headers, body });
      }
      resolve(answers);
    });
    socket.end(requests.join(""));
  });
}

function request(method: string, path: string, lines: string[] = [], body?: string): string {
  const head = [`${method} ${path} HTTP/1.1`, "Host: 127.0.0.1", ...lines];
  if (body === undefined) return `${head.join("\r\n")}\r\n\r\n`;
  return `${head.join("\r\n")}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
}

const one = async (port: number, raw: string): Promise<Answer> => {
  const [answer] = await send(port, [
    raw.replace("HTTP/1.1\r\n", "HTTP/1.1\r\nConnection: close\r\n"),
  ]);
  if (answer === undefined) throw new Error("no answer");
  return answer;
};

const saveBody = (txid: string) =>
  JSON.stringify({
    documentId: "d",
    clientTransactionId: txid,
    baseRevision: 0,
    segments: ["e30"],
    document: "e30",
  });

let server: Running | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function start(options: { trusted?: string; routes: Route[]; log?: RateLimitLog }) {
  const clock = createFakeClock(0);
  const layers = createLayers({
    expectedOrigin: ORIGIN,
    trustedProxies: parseTrustedProxies(options.trusted) ?? [],
    rateLimiter: createRateLimiter({
      limits: LIMITS,
      now: clock.nowMs,
      sessionTokenOf: (r) => sessionTokenFromCookie(r.headers.cookie),
    }),
    ...(options.log === undefined ? {} : { rateLimitLog: options.log }),
  });
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    layers,
    routes: options.routes,
    databases: createDatabases(),
  });
  return { clock, port: server.port };
}

describe("rate limit on a real server", () => {
  it("answers 429 too_many_requests with Retry-After and a locale key (N15, N16)", async () => {
    const counter = { n: 0 };
    const logged: unknown[] = [];
    const { port } = await start({ routes: [readRoute(counter)], log: (f) => logged.push(f) });
    const statuses: number[] = [];
    let last: Answer | undefined;
    for (let i = 0; i < 4; i += 1) {
      last = await one(port, request("GET", `${READ}?i=${i}`));
      statuses.push(last.status);
    }
    expect(statuses).toEqual([200, 200, 200, 429]);
    expect(counter.n).toBe(3);
    expect(last?.headers["retry-after"]).toBe("20");
    expect(last?.headers.connection).toBe("close");
    expect(JSON.parse(last?.body ?? "")).toEqual({
      error: "too_many_requests",
      code: "too_many_requests",
      messageKey: "errors.tooManyRequests",
      status: 429,
      requestId: expect.any(String),
    });
    expect(logged).toEqual([{ route: READ, bucket: "per_address" }]);
    expect(last?.body).not.toMatch(/127\.0\.0\.1|per_address/u);
  });

  it("a forged X-Forwarded-For from a direct peer does not get round it (N1)", async () => {
    const counter = { n: 0 };
    const { port } = await start({ routes: [readRoute(counter)] });
    const statuses: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      statuses.push(
        (await one(port, request("GET", READ, [`X-Forwarded-For: 198.51.100.${i}`]))).status,
      );
    }
    expect(statuses).toEqual([200, 200, 200, 429, 429]);
  });

  it("forged entries left of the trusted proxy's own do not move the bucket (N2)", async () => {
    const counter = { n: 0 };
    const { port } = await start({ trusted: "127.0.0.1", routes: [readRoute(counter)] });
    const statuses: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const xff = `X-Forwarded-For: 198.51.100.${i}, 203.0.113.9`;
      statuses.push((await one(port, request("GET", READ, [xff]))).status);
    }
    expect(statuses).toEqual([200, 200, 200, 429, 429]);
  });

  it("one session on many addresses meets its account limit, even with a decoy cookie (N4, B1)", async () => {
    const counter = { n: 0 };
    const { port } = await start({ trusted: "127.0.0.1", routes: [readRoute(counter)] });
    const statuses: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      const cookie = `Cookie: ${SESSION}=${TOKEN_A}; ${SESSION} =z; ${SESSION} =y`;
      expect(sessionTokenFromCookie(cookie.slice(8))).toBe(TOKEN_A);
      statuses.push(
        (await one(port, request("GET", READ, [`X-Forwarded-For: 203.0.113.${i}`, cookie]))).status,
      );
    }
    expect(statuses).toEqual([200, 200, 429, 429]);
  });

  it("a refused save sent again after Retry-After is stored exactly once (N7)", async () => {
    const stored: string[] = [];
    const { port, clock } = await start({ routes: [savingRoute(stored)] });
    const save = (txid: string) =>
      one(port, request("POST", SAVE, [`Origin: ${ORIGIN}`], saveBody(txid)));
    expect((await save("tx-1")).status).toBe(200);
    expect((await save("tx-2")).status).toBe(200);
    const refused = await save("tx-3");
    expect(refused.status).toBe(429);
    expect(stored).toEqual(["tx-1", "tx-2"]);
    clock.advance(Number(refused.headers["retry-after"]) * 1000);
    const again = await save("tx-3");
    expect([again.status, JSON.parse(again.body)]).toEqual([200, { status: "committed" }]);
    expect(stored).toEqual(["tx-1", "tx-2", "tx-3"]);
  });

  it("nothing pipelined behind a 429 reaches the handler (N13)", async () => {
    const counter = { n: 0 };
    const { port } = await start({ routes: [readRoute(counter)] });
    const answers = await send(
      port,
      [1, 2, 3, 4, 5, 6].map((i) => request("GET", `${READ}?p=${i}`)),
    );
    expect(answers.map((a) => a.status)).toEqual([200, 200, 200, 429]);
    expect(counter.n).toBe(3);
  });
});

// QA on DAN-814 b (c.6909256164): the production path, createLayers() without a
// limiter (server/server.ts), limits with the catalogue's defaults, and each
// server counts on its own. Login is the smallest default (30 a minute per
// address); the real clock refills about one token in two seconds, far more
// than these requests take.
describe("the default limiter of createLayers()", () => {
  const LOGIN = "/api/v1/auth/login";
  const startDefault = async (): Promise<Running> =>
    startServer({
      host: "127.0.0.1",
      port: 0,
      layers: createLayers({ expectedOrigin: ORIGIN }),
      routes: [],
      databases: createDatabases(),
    });
  const others: Running[] = [];
  afterEach(async () => {
    await Promise.all(others.splice(0).map((running) => running.close()));
  });

  it("refuses past the default login limit, and a second server has its own buckets", async () => {
    const first = await startDefault();
    const second = await startDefault();
    others.push(first, second);
    const statuses: number[] = [];
    for (let i = 0; i < DEFAULT_RATE_LIMITS.login.perIp + 2; i += 1) {
      statuses.push((await one(first.port, request("GET", LOGIN))).status);
    }
    const limit = DEFAULT_RATE_LIMITS.login.perIp;
    expect(statuses.slice(0, limit).includes(429)).toBe(false);
    expect(statuses.slice(limit)).toEqual([429, 429]);
    const refused = await one(first.port, request("GET", LOGIN));
    expect(JSON.parse(refused.body)).toMatchObject({ code: "too_many_requests", status: 429 });
    expect(Number(refused.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    // The same address on another server: its buckets are untouched.
    expect((await one(second.port, request("GET", LOGIN))).status).not.toBe(429);
  });
});

// QA on DAN-814 b (c.6909628841): the default record of a refusal keeps the
// contract route. logEvent passes every field through redact, which blanks a
// path such as /api/v1/settings/catalogue as if it were a token.
describe("the default record of a refusal", () => {
  afterEach(() => vi.restoreAllMocks());

  it("names the contract route and the bucket on stderr, and nothing else (N16)", async () => {
    const CATALOGUE = "/api/v1/settings/catalogue";
    expect(JSON.stringify(redact({ route: CATALOGUE }))).not.toContain(CATALOGUE);
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    const clock = createFakeClock(0);
    const layers = createLayers({
      expectedOrigin: ORIGIN,
      rateLimiter: createRateLimiter({
        limits: LIMITS,
        now: clock.nowMs,
        sessionTokenOf: (r) => sessionTokenFromCookie(r.headers.cookie),
      }),
    });
    server = await startServer({
      host: "127.0.0.1",
      port: 0,
      layers,
      routes: [],
      databases: createDatabases(),
    });
    const port = server.port;
    const cookie = `Cookie: ${SESSION}=${TOKEN_A}`;
    for (let i = 0; i < LIMITS.default.perAccount!; i += 1)
      await one(port, request("GET", CATALOGUE, [cookie]));
    expect((await one(port, request("GET", `${CATALOGUE}?x=1`, [cookie]))).status).toBe(429);
    expect((await one(port, request("GET", "/api/v1/no-such-route", [cookie]))).status).toBe(429);
    const records = lines
      .map((line) => JSON.parse(line) as { event?: string; level?: string; fields?: unknown })
      .filter((record) => record.event === "traffic.rate_limited");
    expect(records.map((r) => [r.level, r.fields])).toEqual([
      ["warn", { route: CATALOGUE, bucket: "per_account" }],
      ["warn", { bucket: "per_account" }],
    ]);
    expect(lines.join("\n")).not.toMatch(new RegExp(`127\\.0\\.0\\.1|${TOKEN_A}`, "u"));
  });

  it("does so on the production path too: createLayers() with nothing injected", async () => {
    const CATALOGUE = "/api/v1/settings/catalogue";
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    server = await startServer({
      host: "127.0.0.1",
      port: 0,
      layers: createLayers({ expectedOrigin: ORIGIN }),
      routes: [],
      databases: createDatabases(),
    });
    // Past the default account limit in one pipelined write, so the real clock
    // refills next to nothing; the 429 closes the connection and ends the run.
    const cookie = `Cookie: ${SESSION}=${TOKEN_A}`;
    const count = (DEFAULT_RATE_LIMITS.default.perAccount ?? 0) + 20;
    const answers = await send(
      server.port,
      Array.from({ length: count }, () => request("GET", CATALOGUE, [cookie])),
    );
    expect(answers.at(-1)?.status).toBe(429);
    const records = lines
      .map((line) => JSON.parse(line) as { event?: string; fields?: unknown })
      .filter((record) => record.event === "traffic.rate_limited");
    expect(records.map((r) => r.fields)).toEqual([{ route: CATALOGUE, bucket: "per_account" }]);
  });
});

// DAN-853-1a: enrolment is in its own class (S-1C.3). The path is the one of
// the route's contract, so the class and the route cannot drift apart.
describe("enrolment is under its own rate limit (DAN-853-1a)", () => {
  const ENROLL = contractOf("institution.enrollments.post");
  const enroll = (port: number, lines: string[]) =>
    one(port, request("POST", ENROLL.path, [`Origin: ${ORIGIN}`, ...lines], '{"code":"x"}'));
  const enrollRoute = (counter: { n: number }): Route => ({
    contract: ENROLL,
    handle: async (request, response) => {
      for await (const chunk of request) void chunk;
      counter.n += 1;
      response.writeHead(200, { "content-type": "application/json" }).end("{}");
    },
  });

  it("one session on many addresses meets the enrolment account limit", async () => {
    const counter = { n: 0 };
    const logged: unknown[] = [];
    const routes = [enrollRoute(counter), readRoute({ n: 0 })];
    const { port } = await start({ trusted: "127.0.0.1", routes, log: (f) => logged.push(f) });
    const statuses: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      const lines = [`X-Forwarded-For: 203.0.113.${i}`, `Cookie: ${SESSION}=${TOKEN_A}`];
      statuses.push((await enroll(port, lines)).status);
    }
    expect(statuses).toEqual([200, 200, 429, 429]);
    expect(counter.n).toBe(LIMITS.enroll.perAccount);
    expect(logged).toEqual([
      { route: ENROLL.path, bucket: "per_account" },
      { route: ENROLL.path, bucket: "per_account" },
    ]);
    // The default account bucket of the same session is untouched.
    const read = [`X-Forwarded-For: 203.0.113.9`, `Cookie: ${SESSION}=${TOKEN_A}`];
    expect((await one(port, request("GET", READ, read))).status).toBe(200);
  });

  it("without a cookie one address meets the enrolment address limit", async () => {
    const counter = { n: 0 };
    const logged: unknown[] = [];
    const routes = [enrollRoute(counter), readRoute({ n: 0 })];
    const { port } = await start({ routes, log: (f) => logged.push(f) });
    const statuses: number[] = [];
    for (let i = 0; i < 3; i += 1) statuses.push((await enroll(port, [])).status);
    expect(statuses).toEqual([200, 200, 429]);
    expect(counter.n).toBe(LIMITS.enroll.perIp);
    expect(logged).toEqual([{ route: ENROLL.path, bucket: "per_address" }]);
    // A full enrolment bucket leaves the default one of the same address open.
    expect((await one(port, request("GET", READ))).status).toBe(200);
  });

  it("keeps enrolment and default apart, and lets it through again after Retry-After", async () => {
    const reads = { n: 0 };
    const enrolments = { n: 0 };
    const { port, clock } = await start({ routes: [readRoute(reads), enrollRoute(enrolments)] });
    for (let i = 0; i < 3; i += 1) await one(port, request("GET", READ));
    expect((await one(port, request("GET", READ))).status).toBe(429);
    expect((await enroll(port, [])).status).toBe(200);
    expect((await enroll(port, [])).status).toBe(200);
    const refused = await enroll(port, []);
    expect([refused.status, JSON.parse(refused.body).code]).toEqual([429, "too_many_requests"]);
    clock.advance(Number(refused.headers["retry-after"]) * 1000);
    expect((await enroll(port, [])).status).toBe(200);
    expect(enrolments.n).toBe(3);
  });

  it("on the production path: the eleventh enrolment of a session is refused, a read is not", async () => {
    server = await startServer({
      host: "127.0.0.1",
      port: 0,
      layers: createLayers({ expectedOrigin: ORIGIN }),
      routes: [],
      databases: createDatabases(),
    });
    const cookie = `Cookie: ${SESSION}=${TOKEN_A}`;
    const limit = DEFAULT_RATE_LIMITS.enroll.perAccount ?? 0;
    const statuses: number[] = [];
    for (let i = 0; i < limit + 3; i += 1)
      statuses.push((await enroll(server.port, [cookie])).status);
    // The real clock gives back one token in six seconds, far more than this takes.
    expect(statuses.slice(0, limit).includes(429)).toBe(false);
    expect(statuses[limit]).toBe(429);
    expect(statuses.at(-1)).toBe(429);
    expect((await one(server.port, request("GET", READ, [cookie]))).status).not.toBe(429);
  });
});

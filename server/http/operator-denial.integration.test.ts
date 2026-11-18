// Refusals of operator paths are recorded, on a real node:http server (S-1J.2,
// DAN-842-3; contract Ductus#1836 c.6950325128): one record per refusal of
// step 3 or step 8, with the answer's request id, never the token, the cookie,
// the IP or the raw path, and a broken log never changes the answer. Tokens
// are invented; addresses are loopback and documentation ranges.
import { request as httpRequest } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { ROUTES } from "../contracts/index.ts";
import type { LogWriter } from "../log/index.ts";
import { type AllowedNetworks, parseAllowedNetworks } from "../traffic/index.ts";
import { createDatabases } from "./databases.ts";
import { createOperatorDenialLog, type OperatorDenialLog } from "./operator-denial-log.ts";
import type { OperatorList, SecondFactor } from "./operator-policy-layer.ts";
import { createLayers } from "./pipeline.ts";
import type { Route } from "./router.ts";
import { type Running, startServer } from "./start.ts";

const OPS = "/api/v1/ops/x";
const TOKEN = "Izmisljeni_token-zapisa_odbijanja_000000002";
const COOKIE = `__Host-ductus_session=${TOKEN}`;
const PROBES = [OPS, "/api/v1/ops", "/API/V1/OPS/x", "/api/v1/ops/x?a=1"];
const read = ROUTES.find((route) => route.id === "student.assignments.get")!;

const nets = (text: string): (() => AllowedNetworks) => {
  const parsed = parseAllowedNetworks(text)!;
  return () => parsed;
};
const OUTSIDE = nets("192.0.2.0/24");
const INSIDE = nets("127.0.0.0/8");

type Entry = Parameters<OperatorDenialLog>[0];
type Answer = { status: number; code?: string; requestId?: string };

let server: Running | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function start(options: {
  networks: () => AllowedNetworks;
  secondFactor?: SecondFactor;
  operators?: OperatorList;
  log?: OperatorDenialLog;
  limited?: boolean;
}) {
  const entries: Entry[] = [];
  const ports: string[] = [];
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    layers: createLayers({
      expectedOrigin: "https://ductura.invalid",
      rateLimiter: {
        check: () =>
          options.limited === true
            ? { allowed: false, limitClass: "default", bucket: "per_address", retryAfter: 1 }
            : { allowed: true, limitClass: "default" },
      },
      rateLimitLog: () => undefined,
      allowedNetworks: options.networks,
      secondFactor: (token) => (
        ports.push(token),
        (options.secondFactor ?? (async () => "unconfirmed"))(token)
      ),
      operators: options.operators ?? (async () => "listed"),
      operatorDenialLog: options.log ?? ((entry) => entries.push(entry)),
    }),
    routes: [OPS, "/api/v1/ops"].map((path): Route => ({
      contract: { ...read, path },
      handle: async (_request, response) => {
        response.writeHead(200, { "content-type": "application/json" }).end("{}");
      },
    })),
    databases: createDatabases(),
  });
  const port = server.port;
  const get = (path: string, cookie?: string) =>
    new Promise<Answer>((resolve, reject) => {
      const headers = cookie === undefined ? {} : { cookie };
      const req = httpRequest({ host: "127.0.0.1", port, path, headers, agent: false }, (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
        res.on("end", () => {
          const code = body === "" ? undefined : (JSON.parse(body) as { code?: string }).code;
          const requestId = res.headers["x-request-id"];
          resolve({
            status: res.statusCode ?? 0,
            ...(code === undefined ? {} : { code }),
            ...(typeof requestId === "string" ? { requestId } : {}),
          });
        });
      });
      req.on("error", reject);
      req.end();
    });
  return { get, entries, ports };
}

const throwing =
  (message: string): SecondFactor =>
  async () => {
    throw new Error(message);
  };

describe("refusals of operator paths are recorded", () => {
  it.each([
    ["network_not_allowed", { networks: OUTSIDE }, COOKIE, 403],
    ["not_signed_in", { networks: INSIDE }, undefined, 401],
    [
      "session_unknown",
      { networks: INSIDE, secondFactor: async () => "unauthenticated" as const },
      COOKIE,
      401,
    ],
    [
      "not_operator",
      { networks: INSIDE, operators: async () => "not_listed" as const },
      COOKIE,
      403,
    ],
    ["second_factor_required", { networks: INSIDE }, COOKIE, 403],
    [
      "unavailable",
      { networks: INSIDE, secondFactor: throwing(`port down ${TOKEN}`) },
      COOKIE,
      503,
    ],
  ] as const)(
    "%s: one record per refusal, with the answer's request id",
    async (reason, options, cookie, status) => {
      const { get, entries } = await start(options);
      for (const path of PROBES) {
        const before = entries.length;
        const answer = await get(path, cookie);
        expect(answer.status, path).toBe(status);
        expect(entries.slice(before), path).toEqual([
          { requestId: answer.requestId, route: path.split("?", 1)[0], reason },
        ]);
      }
      expect(JSON.stringify(entries)).not.toContain(TOKEN);
      expect(JSON.stringify(entries)).not.toMatch(/127\.0\.0\.1|192\.0\.2|a=1/u);
    },
  );

  it("step 3 records once and never asks the port", async () => {
    const { get, entries, ports } = await start({ networks: OUTSIDE });
    await get(OPS, COOKIE);
    expect(entries.map((e) => e.reason)).toEqual(["network_not_allowed"]);
    expect(ports).toEqual([]);
  });

  it.each([
    ["toString", async () => "toString" as never],
    ["__proto__", async () => "__proto__" as never],
    ["a thenable", async () => ({ then: (r: (v: unknown) => void) => r("yes") }) as never],
  ])("a port answering %s is recorded as unavailable", async (_name, port) => {
    const { get, entries } = await start({ networks: INSIDE, secondFactor: port as SecondFactor });
    expect((await get(OPS, COOKIE)).status).toBe(503);
    expect(entries.map((e) => e.reason)).toEqual(["unavailable"]);
  });

  it("records nothing for a pass, a path that is not an operator path, or a rate-limited request", async () => {
    const pass = await start({ networks: INSIDE, secondFactor: async () => "confirmed" });
    expect((await pass.get(OPS, COOKIE)).status).toBe(200);
    expect((await pass.get("/api/v1/health")).status).toBe(404);
    expect(pass.entries).toEqual([]);
    await server?.close();
    const limited = await start({ networks: INSIDE, limited: true });
    expect((await limited.get(OPS, COOKIE)).status).toBe(429);
    expect(limited.entries).toEqual([]);
  });

  it("concurrent refusals have distinct request ids", async () => {
    const { get, entries } = await start({ networks: INSIDE });
    const answers = await Promise.all(Array.from({ length: 8 }, () => get(OPS, COOKIE)));
    expect(new Set(entries.map((e) => e.requestId)).size).toBe(8);
    expect(new Set(entries.map((e) => e.requestId))).toEqual(
      new Set(answers.map((a) => a.requestId)),
    );
  });

  it.each([
    [
      "a log that throws",
      (): OperatorDenialLog => () => {
        throw new Error("log broken");
      },
    ],
    [
      "a writer that rejects",
      () =>
        createOperatorDenialLog({ write: (() => Promise.reject(new Error("down"))) as LogWriter }),
    ],
    [
      "a writer that never settles",
      () => createOperatorDenialLog({ write: (() => new Promise(() => {})) as LogWriter }),
    ],
  ])("%s does not change the answer", async (_name, makeLog) => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const { get } = await start({ networks: INSIDE, log: makeLog() });
      const answer = await get(OPS, COOKIE);
      expect({ status: answer.status, code: answer.code }).toEqual({
        status: 403,
        code: "forbidden",
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

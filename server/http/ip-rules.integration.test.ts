// The IP rules of operator paths on a real node:http server (S-1C.2,
// DAN-832-1; contract Ductus#1836): 403 forbidden before the rate limit and
// the handler, the answer names no address, a forged X-Forwarded-For does not
// help. No operator route exists yet, so a test route stands on an operator
// path. Addresses are from the documentation ranges and loopback.
import { request as httpRequest } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { ROUTES } from "../contracts/index.ts";
import {
  type AllowedNetworks,
  createRateLimiter,
  parseAllowedNetworks,
  parseTrustedProxies,
} from "../traffic/index.ts";
import { createDatabases } from "./databases.ts";
import { createLayers } from "./pipeline.ts";
import type { Route } from "./router.ts";
import { type Running, startServer } from "./start.ts";

const OPS = "/api/v1/ops/ip-rules";
const TOKEN = "Izmisljeni_token-pravila_mreze_000000000001";
const READ = "/api/v1/student/assignments";
const read = ROUTES.find((route) => route.id === "student.assignments.get");
if (read === undefined) throw new Error("no contract student.assignments.get");

const counting = (path: string, calls: string[]): Route => ({
  contract: { ...read, path },
  handle: async (_request, response) => {
    calls.push(path);
    response.writeHead(200, { "content-type": "application/json" }).end("{}");
  },
});

let server: Running | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function start(options: { networks: () => AllowedNetworks; trusted?: string }) {
  const calls: string[] = [];
  const limited: string[] = [];
  const limiter = createRateLimiter({ sessionTokenOf: () => null });
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    layers: createLayers({
      expectedOrigin: "https://ductura.invalid",
      trustedProxies: parseTrustedProxies(options.trusted) ?? [],
      rateLimiter: { check: (r) => (limited.push(r.url ?? ""), limiter.check(r)) },
      allowedNetworks: options.networks,
      // Step 8 (DAN-842-1) is open here, so only step 3 decides.
      secondFactor: async () => "confirmed",
    }),
    routes: [counting(OPS, calls), counting(READ, calls)],
    databases: createDatabases(),
  });
  const port = server.port;
  const get = (path: string, extra: Record<string, string> = {}) =>
    new Promise<{ status: number; body: string; connection?: string }>((resolve, reject) => {
      const headers = { cookie: `__Host-ductus_session=${TOKEN}`, ...extra };
      const req = httpRequest({ host: "127.0.0.1", port, path, headers, agent: false }, (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
        res.on("end", () => {
          const connection = res.headers.connection;
          resolve({ status: res.statusCode ?? 0, body, ...(connection ? { connection } : {}) });
        });
      });
      req.on("error", reject);
      req.end();
    });
  return { get, calls, limited };
}

const nets = (text: string) => {
  const parsed = parseAllowedNetworks(text);
  if (parsed === null) throw new Error(`bad networks ${text}`);
  return () => parsed;
};

describe("IP rules on a real server", () => {
  it("refuses an operator path from outside the list with 403 forbidden, before the limit", async () => {
    const { get, calls, limited } = await start({ networks: nets("192.0.2.0/24") });
    const answer = await get(OPS);
    expect(answer.status).toBe(403);
    expect(answer.connection).toBe("close");
    expect(JSON.parse(answer.body)).toMatchObject({
      code: "forbidden",
      messageKey: "errors.forbidden",
      status: 403,
    });
    expect(answer.body).not.toMatch(/127\.0\.0\.1|192\.0\.2/u);
    expect(calls).toEqual([]);
    expect(limited).toEqual([]);
  });

  it("a forged X-Forwarded-For with an allowed address does not help", async () => {
    const { get, calls } = await start({ networks: nets("192.0.2.0/24") });
    expect((await get(OPS, { "x-forwarded-for": "192.0.2.1" })).status).toBe(403);
    expect(calls).toEqual([]);
  });

  it("other paths from the same address pass", async () => {
    const { get, calls } = await start({ networks: nets("192.0.2.0/24") });
    expect((await get(READ)).status).toBe(200);
    expect(calls).toEqual([READ]);
  });

  it("an address inside the list reaches the handler, also through a trusted proxy", async () => {
    const direct = await start({ networks: nets("127.0.0.0/8") });
    expect((await direct.get(OPS)).status).toBe(200);
    await server?.close();
    const proxied = await start({ networks: nets("192.0.2.0/24"), trusted: "127.0.0.1" });
    expect((await proxied.get(OPS, { "x-forwarded-for": "192.0.2.1" })).status).toBe(200);
    expect(proxied.calls).toEqual([OPS]);
  });

  it("the empty list (default) changes nothing", async () => {
    const { get, calls } = await start({ networks: nets("") });
    expect((await get(OPS)).status).toBe(200);
    expect(calls).toEqual([OPS]);
  });

  it("a list that throws or was not parsed closes only operator paths", async () => {
    const thrown = await start({
      networks: () => {
        throw new Error("settings unavailable");
      },
    });
    expect((await thrown.get(OPS)).status).toBe(500);
    expect((await thrown.get(READ)).status).toBe(200);
    expect(thrown.calls).toEqual([READ]);
    await server?.close();
    const forged = await start({ networks: () => ["127.0.0.0/8"] as unknown as AllowedNetworks });
    expect((await forged.get(OPS)).status).toBe(403);
  });
});

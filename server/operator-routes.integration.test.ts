// No route the real entry point mounts goes around step 8 (S-1J.2, DAN-842-2,
// round 3: order on ductura/server#245 c.6948920667, contract c.6948963681).
// The test reads no source text. It starts the real server/server.ts in this
// process and checks, at run time, what main() hands to startServer, after
// every .map, spread or alias in the entry: every mounted route that is an
// operator route by its id or by its path answers a request without a
// session cookie with step 8's 401 on the running server, and the start
// listens exactly once. Only side effects are switched off (signals, the
// metrics interval); layers, factories, router and pipeline are the real ones.
import { createServer, request as httpRequest } from "node:http";
import { Server as NetServer } from "node:net";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type * as httpModule from "./http/index.ts";
import {
  createLayers,
  createShutdownCoordinator,
  PIPELINE_STEPS,
  type Route,
  type StartOptions,
  startServer as realStart,
} from "./http/index.ts";

// Counts every listen of a net.Server (http servers are ones) from before the
// first module of this file loads: vi.hoisted runs ahead of every import, so a
// listen at module level anywhere in the http graph or the entry is counted
// too (review on #245 at 60657f1). It stops counting once the entry started.
const early = vi.hoisted(() => {
  const { Server } = process.getBuiltinModule("node:net");
  const original = Server.prototype.listen;
  const state = { count: 0, counting: true, beforeHttp: false };
  Server.prototype.listen = function (this: InstanceType<typeof Server>, ...args: unknown[]) {
    if (state.counting) state.count += 1;
    return (original as (...a: unknown[]) => InstanceType<typeof Server>).apply(this, args);
  } as typeof original;
  return state;
});

type Running = Awaited<ReturnType<typeof httpModule.startServer>>;
const started: { options: StartOptions; running: Running }[] = [];
// Only the start of server/server.ts is recorded, not the servers this test builds.
let recording = false;

vi.mock("./http/index.ts", async (importOriginal) => {
  // The http graph loads here, after the counter: a later counter would miss its module-level listens.
  early.beforeHttp = early.counting;
  const real = await importOriginal<typeof httpModule>();
  return {
    ...real,
    startServer: async (options: StartOptions) => {
      const running = await real.startServer(options);
      if (recording) started.push({ options, running });
      return running;
    },
    installShutdown: () => undefined,
    createMetricsSampling: (options: Parameters<typeof real.createMetricsSampling>[0]) => ({
      ...real.createMetricsSampling(options),
      start: () => undefined,
    }),
  };
});

/** Counts every listen of a net.Server (http servers are ones) while `run` runs. */
async function listensDuring(run: () => Promise<unknown>): Promise<number> {
  const original = NetServer.prototype.listen;
  let count = 0;
  NetServer.prototype.listen = function (this: NetServer, ...args: unknown[]) {
    count += 1;
    return (original as (...a: unknown[]) => NetServer).apply(this, args);
  } as typeof original;
  try {
    await run();
  } finally {
    NetServer.prototype.listen = original;
  }
  return count;
}

const ORIGIN = "https://ductura.invalid";
const OPS = "/api/v1/ops";
// Contract paths are canonical (server/contracts/check.ts), so a prefix test is exact here.
const isOperator = (route: Route): boolean =>
  route.contract.id.split(".", 1)[0] === "ops" ||
  route.contract.path === OPS ||
  route.contract.path.startsWith(`${OPS}/`);

function send(
  port: number,
  method: string,
  path: string,
): Promise<{ status: number; code?: string }> {
  return new Promise((resolve, reject) => {
    // A same-site browser request, so step 7 lets a state-changing one reach step 8.
    const headers = { origin: ORIGIN, "sec-fetch-site": "same-origin" };
    const req = httpRequest(
      { host: "127.0.0.1", port, method, path, headers, agent: false },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
        res.on("end", () => {
          let code: string | undefined;
          try {
            code = (JSON.parse(body) as { code?: string }).code;
          } catch {
            code = undefined;
          }
          resolve({ status: res.statusCode ?? 0, ...(code === undefined ? {} : { code }) });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** Operator routes among `routes` that a request without a session cookie reaches past step 8. */
async function unguarded(port: number, routes: readonly Route[]): Promise<string[]> {
  const found: string[] = [];
  for (const route of routes.filter(isOperator)) {
    const path = route.contract.path.replace(/\{[A-Za-z]+\}/gu, "x");
    const answer = await send(port, route.contract.method, path);
    if (answer.status !== 401 || answer.code !== "unauthenticated") found.push(route.contract.id);
  }
  return found;
}

const ENV = {
  APP_DATABASE_URL: "postgres://app:x@db.invalid:5432/ductura",
  APP_ORIGIN: ORIGIN,
  PORT: "0",
  HOST: "127.0.0.1",
};
const saved = Object.fromEntries(Object.keys(ENV).map((key) => [key, process.env[key]]));
let listens = 0;

beforeAll(async () => {
  Object.assign(process.env, ENV);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    recording = true;
    await import("./server.ts");
  } finally {
    recording = false;
    early.counting = false;
    listens = early.count;
    log.mockRestore();
  }
}, 30_000);

afterAll(async () => {
  for (const { running } of started) await running.close();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("the real entry point and step 8", () => {
  it("starts exactly one server and listens exactly once, counted from before the http graph loads", () => {
    expect(early.beforeHttp).toBe(true);
    expect(started).toHaveLength(1);
    expect(listens).toBe(1);
    expect(started[0]!.options.routes.length).toBeGreaterThan(10);
  });

  it("its layers are frozen and are exactly the pipeline steps", () => {
    const { layers } = started[0]!.options;
    expect(Object.isFrozen(layers)).toBe(true);
    expect(Object.keys(layers).sort()).toEqual([...PIPELINE_STEPS].sort());
  });

  it("every mounted operator route, and an operator path, stop at step 8 without a session", async () => {
    const { options, running } = started[0]!;
    expect(await unguarded(running.port, options.routes)).toEqual([]);
    expect(await send(running.port, "GET", `${OPS}/x`)).toEqual({
      status: 401,
      code: "unauthenticated",
    });
  });
});

describe("the run-time checks find what they look for", () => {
  it("an operator id on a path outside /api/v1/ops is reached past step 8", async () => {
    const health = started[0]!.options.routes.find((r) => r.contract.id === "platform.health.get")!;
    const renamed: Route = { ...health, contract: { ...health.contract, id: "ops.health.get" } };
    const server = await realStart({
      host: "127.0.0.1",
      port: 0,
      layers: createLayers({ expectedOrigin: ORIGIN }),
      routes: [renamed],
      databases: started[0]!.options.databases,
      shutdown: createShutdownCoordinator({ graceMs: 1_000 }),
    });
    try {
      expect(await unguarded(server.port, [renamed])).toEqual(["ops.health.get"]);
    } finally {
      await server.close();
    }
  });

  it("a second server is a second listen", async () => {
    const extra = createServer();
    const count = await listensDuring(
      () => new Promise<void>((resolve) => extra.listen(0, "127.0.0.1", resolve)),
    );
    extra.close();
    expect(count).toBe(1);
    expect(await listensDuring(async () => undefined)).toBe(0);
  });
});

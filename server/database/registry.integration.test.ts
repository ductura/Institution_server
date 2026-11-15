// S-1F-a (DAN-783) with the real driver and no PostgreSQL: the logs database
// is stopped (a port nobody listens on) or frozen (a server that accepts and
// never answers). Its state is `nedostupno` within the health limit, the
// other databases are not held back, and no error or log line carries the
// invented password.
import { createServer, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

import { appPoolConfig } from "./index.ts";
import { createRegistry, HEALTH_TIMEOUT_MS, POOLS, type Registry } from "./registry.ts";

const CANARY = "invented-canary-pw-k8Vd";
const urlAt = (port: number, user: string) =>
  `postgres://${user}:${CANARY}@127.0.0.1:${port}/ductura_${user}?sslmode=disable`;

const open: { registry?: Registry | undefined; servers: Server[]; sockets: Socket[] } = {
  servers: [],
  sockets: [],
};

async function listen(onSocket: (socket: Socket) => void): Promise<number> {
  const server = createServer((socket) => {
    open.sockets.push(socket);
    onSocket(socket);
  });
  open.servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return (server.address() as { port: number }).port;
}

// A port that was free a moment ago and has no listener now: a stopped database.
async function stoppedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as { port: number };
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}

function registryOf(env: Record<string, string>): Registry {
  open.registry = createRegistry(env, {
    settings: (connectionString, name) => ({
      ...appPoolConfig(connectionString),
      application_name: `ductura-${name}`,
      connectionTimeoutMillis: 1_000,
    }),
  });
  return open.registry;
}

afterEach(async () => {
  await open.registry?.close().catch(() => undefined);
  open.registry = undefined;
  for (const socket of open.sockets.splice(0)) socket.destroy();
  await Promise.all(
    open.servers.splice(0).map((server) => new Promise((done) => server.close(done))),
  );
  vi.restoreAllMocks();
});

describe("registry with a database that is down", () => {
  it("reports a stopped logs database apart, without its password", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const registry = registryOf({ [POOLS.logs.variable]: urlAt(await stoppedPort(), "logs") });

    const report = await registry.health();
    expect(report).toEqual({
      main: "nije_konfigurirano",
      logs: "nedostupno",
      legal: "nije_konfigurirano",
    });

    const failure = await registry
      .pool("logs")
      .query("SELECT 1")
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(Error);
    const text = [String(failure), (failure as Error).stack, JSON.stringify(failure)].join("\n");
    expect(text).not.toContain(CANARY);
    expect(JSON.stringify(logged.mock.calls)).not.toContain(CANARY);
  });

  it("answers within the health limit while logs is frozen and main is stopped", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const frozen = await listen(() => undefined);
    const registry = registryOf({
      [POOLS.main.variable]: urlAt(await stoppedPort(), "app"),
      [POOLS.logs.variable]: urlAt(frozen, "logs"),
    });

    const started = performance.now();
    const report = await registry.health();
    expect(performance.now() - started).toBeLessThan(HEALTH_TIMEOUT_MS + 1_000);
    expect(report).toEqual({ main: "nedostupno", logs: "nedostupno", legal: "nije_konfigurirano" });
    expect(JSON.stringify(logged.mock.calls)).not.toContain(CANARY);
  });

  it("closes every pool, also one with a connection still being made", async () => {
    const frozen = await listen(() => undefined);
    const registry = registryOf({ [POOLS.logs.variable]: urlAt(frozen, "logs") });
    const pending = registry
      .pool("logs")
      .query("SELECT 1")
      .catch(() => undefined);
    await registry.close();
    await pending;
    expect(() => registry.pool("logs")).toThrow("database pools are closed");
  });
});

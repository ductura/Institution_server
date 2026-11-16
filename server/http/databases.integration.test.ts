// S-1F-a (DAN-783) over real HTTP: with the logs database stopped, the
// liveness answer of /api/v1/health stays byte for byte what it is with every
// database up, while the registry reports logs as `nedostupno`. The URL and
// password are invented; nothing listens on the port.
import { createServer } from "node:net";

import { afterAll, describe, expect, it, vi } from "vitest";

import { createDatabases } from "./databases.ts";
import { createHealthRoute } from "./health.ts";
import { createLayers } from "./pipeline.ts";
import { type Running, startServer } from "./start.ts";

const CANARY = "invented-canary-pw-Hc3m";
const servers: Running[] = [];
afterAll(async () => {
  await Promise.all(servers.map(async (server) => server.close()));
  await createDatabases().close();
  vi.unstubAllEnvs();
});

async function stoppedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as { port: number };
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}

async function healthBytes(): Promise<{ status: number; headers: string; body: string }> {
  const databases = createDatabases();
  const server = await startServer({
    host: "127.0.0.1",
    port: 0,
    layers: createLayers({ expectedOrigin: null }),
    databases,
    routes: [createHealthRoute({ health: databases.health, serverVersion: "0.0.0" })],
  });
  servers.push(server);
  const response = await fetch(`http://127.0.0.1:${server.port}/api/v1/health`);
  const headers = [...response.headers.entries()]
    .filter(([name]) => name !== "date")
    .map(([name, value]) => `${name}: ${value}`)
    .join("\n");
  return { status: response.status, headers, body: await response.text() };
}

describe("health with the logs database down", () => {
  it("answers liveness byte for byte the same", async () => {
    const before = await healthBytes();
    vi.stubEnv("LOGS_DATABASE_URL", `postgres://logs:${CANARY}@127.0.0.1:${await stoppedPort()}/x`);
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const report = await createDatabases().health();
    expect(report.logs).toBe("nedostupno");
    expect(await healthBytes()).toEqual(before);
    expect(before.status).toBe(200);
    expect(JSON.stringify(logged.mock.calls)).not.toContain(CANARY);
  });
});

// Health (S-1M-a, DAN-795) over real HTTP and the real database registry,
// with the main database first frozen (a port that accepts and never
// answers), then gone (nothing listens). Both answer 200 `degraded` within the
// deadline, as the `degraded` vector, with no-store, and with nothing of the
// URL: host, port, database, user and password are invented canaries.
import { createServer, type Server, type Socket } from "node:net";

import { readFileSync } from "node:fs";

import { Value } from "@sinclair/typebox/value";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { ROUTES, type VectorFile } from "../contracts/index.ts";

import { createDatabases } from "./databases.ts";
import { CHECK_DEADLINE_MS, createHealthRoute } from "./health.ts";
import { createLayers } from "./pipeline.ts";
import { type Running, startServer } from "./start.ts";

const USER = "invented-user-h795";
const PASSWORD = "invented-canary-pw-h795";
const DATABASE = "invented_db_h795";
const CANARIES = [USER, PASSWORD, DATABASE, "127.0.0.1:"];

const frozen: Socket[] = [];
let database: Server;
let databasePort: number;
let running: Running;
let logged: string[] = [];
const databases = createDatabases();

beforeAll(async () => {
  // Accepts the connection, reads the startup message and never answers.
  database = createServer((socket) => {
    frozen.push(socket);
    socket.on("error", () => undefined);
  });
  await new Promise<void>((done) => database.listen(0, "127.0.0.1", done));
  databasePort = (database.address() as { port: number }).port;
  vi.stubEnv(
    "APP_DATABASE_URL",
    `postgres://${USER}:${PASSWORD}@127.0.0.1:${databasePort}/${DATABASE}`,
  );
  for (const level of ["log", "info", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(JSON.stringify(args));
    });
  }
  running = await startServer({
    host: "127.0.0.1",
    port: 0,
    layers: createLayers({ expectedOrigin: null }),
    databases,
    routes: [createHealthRoute({ health: databases.health, serverVersion: "0.1.0" })],
  });
});

afterAll(async () => {
  await running.close();
  for (const socket of frozen) socket.destroy();
  if (database.listening) await new Promise<void>((done) => database.close(() => done()));
  await databases.close().catch(() => undefined);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  logged = [];
});

const vectors = JSON.parse(
  readFileSync(new URL("../contracts/vectors/platform.health.get.json", import.meta.url), "utf8"),
) as VectorFile;
const CONTRACT = ROUTES.find((route) => route.id === "platform.health.get");
const DEGRADED = vectors.vectors.find((v) => v.name === "degraded");

async function health(): Promise<{ ms: number; raw: string; response: Response }> {
  const started = Date.now();
  const response = await fetch(`http://127.0.0.1:${running.port}/api/v1/health`);
  const ms = Date.now() - started;
  const head = [...response.headers.entries()].map(([k, v]) => `${k}: ${v}`).join("\n");
  return { ms, raw: `${head}\n${await response.clone().text()}`, response };
}

function expectDegraded(answer: Awaited<ReturnType<typeof health>>, body: unknown): void {
  expect(answer.response.status).toBe(DEGRADED?.response.status);
  expect(answer.response.headers.get("cache-control")).toBe("no-store");
  expect(body).toEqual(DEGRADED?.response.body);
  expect(Value.Check(CONTRACT?.responses[0]?.body as never, body)).toBe(true);
  for (const canary of [...CANARIES, String(databasePort)]) {
    expect(answer.raw).not.toContain(canary);
  }
}

describe("health with the main database down, over real HTTP", () => {
  it("a frozen database: 200 degraded within the deadline, nothing of the URL", async () => {
    const answer = await health();
    expectDegraded(answer, await answer.response.json());
    expect(frozen.length).toBeGreaterThan(0);
    expect(answer.ms).toBeLessThan(CHECK_DEADLINE_MS + 1_000);
  }, 10_000);

  it("a database that is gone: still 200 degraded, nothing of the URL", async () => {
    const closed = new Promise<void>((done) => database.close(() => done()));
    for (const socket of frozen.splice(0)) socket.destroy();
    await closed;
    // Past the reuse window of the first answer.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const answer = await health();
    expectDegraded(answer, await answer.response.json());
    expect(answer.ms).toBeLessThan(CHECK_DEADLINE_MS + 1_000);
  }, 10_000);

  it("logged nothing of the URL either", () => {
    const text = logged.join("\n");
    for (const canary of [USER, PASSWORD, DATABASE]) expect(text).not.toContain(canary);
  });
});

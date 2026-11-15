// S-1F-a (DAN-783) acceptance on the real clusters of the CI job `database`:
// the main database through its application login (APP_DATABASE_URL), the
// logs database in a cluster of its own (LOGS_DATABASE_URL, 127.0.0.1:54330).
// A logs database that is stopped or out of connections does not change what
// the main database answers, health reports each database apart, and after
// close no connection of the registry is left. Every name is random and
// synthetic. With no database it fails, it never skips.
import { randomBytes } from "node:crypto";
import net from "node:net";

import pg from "pg";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import {
  appPoolConfig,
  createRegistry,
  createWithActor,
  POOLS,
  type Registry,
  type WithActor,
} from "../../server/database/index.ts";
import { requireLoopbackDatabaseUrl } from "./loopback-database-url.ts";

const ADMIN_URL = requireLoopbackDatabaseUrl(
  process.env.DATABASE_URL ?? "postgres://ductus:ductus-local-only@127.0.0.1:54329/ductus",
  "The registry test runs only against a loopback main database (DATABASE_URL).",
);
const APP_URL = process.env.APP_DATABASE_URL ?? "";
const LOGS_URL = requireLoopbackDatabaseUrl(
  process.env.LOGS_DATABASE_URL ??
    "postgres://ductus:ductus-logs-local-only@127.0.0.1:54330/ductus_logs",
  "The registry test runs only against a loopback logs database (LOGS_DATABASE_URL).",
);

const admin = new pg.Pool({ connectionString: ADMIN_URL, max: 1 });
const logsAdmin = new pg.Pool({ connectionString: LOGS_URL, max: 1 });
const registries: Registry[] = [];
const run = randomBytes(6).toString("hex");

// A registry whose pools are named ductura-<pool>-<run>, so pg_stat_activity
// shows exactly its connections.
function registryOf(env: Record<string, string>): Registry {
  const registry = createRegistry(env, {
    settings: (connectionString, name) => ({
      ...appPoolConfig(connectionString),
      application_name: `ductura-${name}-${run}`,
      connectionTimeoutMillis: 1_000,
    }),
  });
  registries.push(registry);
  return registry;
}

async function stoppedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as { port: number };
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}

const WHO = "SELECT app.current_user_id() AS user_id, current_user AS login";
const answer = (actor: WithActor) =>
  actor(null, async (tx) => (await tx.query<{ user_id: string | null; login: string }>(WHO)).rows);

async function connectionsOf(pool: pg.Pool, name: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    "SELECT count(*) FROM pg_catalog.pg_stat_activity WHERE application_name = $1",
    [`ductura-${name}-${run}`],
  );
  return Number(result.rows[0]!.count);
}

afterEach(async () => {
  await Promise.all(registries.splice(0).map((registry) => registry.close().catch(() => {})));
});
afterAll(async () => {
  await Promise.all([admin.end(), logsAdmin.end()]);
});

describe("database registry against the real clusters", () => {
  it("answers the main database the same way while the logs database is stopped", async () => {
    const healthy = registryOf({
      [POOLS.main.variable]: APP_URL,
      [POOLS.logs.variable]: LOGS_URL,
    });
    const before = await answer(createWithActor(healthy.pool("main")));
    expect(await healthy.health()).toMatchObject({ main: "ok", logs: "ok" });
    await healthy.close();

    const registry = registryOf({
      [POOLS.main.variable]: APP_URL,
      [POOLS.logs.variable]: LOGS_URL.replace(":54330/", `:${await stoppedPort()}/`),
    });
    const logsFailure = registry.pool("logs").query("SELECT 1");
    await expect(logsFailure).rejects.toThrow();
    expect(await answer(createWithActor(registry.pool("main")))).toEqual(before);
    expect(await registry.health()).toEqual({
      main: "ok",
      logs: "nedostupno",
      legal: "nije_konfigurirano",
    });
  });

  it("answers the main database while every logs connection is taken", async () => {
    const registry = registryOf({
      [POOLS.main.variable]: APP_URL,
      [POOLS.logs.variable]: LOGS_URL,
    });
    const logs = registry.pool("logs") as pg.Pool;
    const held = await Promise.all(
      Array.from({ length: POOLS.logs.max }, async () => logs.connect()),
    );
    try {
      // The logs pool is exhausted: a further call waits and then fails.
      await expect(logs.query("SELECT 1")).rejects.toThrow(/timeout/iu);
      const main = createWithActor(registry.pool("main"));
      await expect(answer(main)).resolves.toHaveLength(1);
      expect(await registry.health()).toMatchObject({ main: "ok", logs: "nedostupno" });
      expect(await connectionsOf(logsAdmin, "logs")).toBe(POOLS.logs.max);
    } finally {
      for (const client of held) client.release();
    }
  });

  it("leaves no connection open after close", async () => {
    const registry = registryOf({
      [POOLS.main.variable]: APP_URL,
      [POOLS.logs.variable]: LOGS_URL,
    });
    await answer(createWithActor(registry.pool("main")));
    await registry.pool("logs").query("SELECT 1");
    expect(await connectionsOf(admin, "main")).toBeGreaterThan(0);
    expect(await connectionsOf(logsAdmin, "logs")).toBeGreaterThan(0);

    await registry.close();
    // The server sees a closed connection a moment after the client ends it.
    await expect
      .poll(
        async () => (await connectionsOf(admin, "main")) + (await connectionsOf(logsAdmin, "logs")),
      )
      .toBe(0);
    expect(() => registry.pool("main")).toThrow("database pools are closed");
  });
});

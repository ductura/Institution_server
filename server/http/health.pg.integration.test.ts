// Health (S-1M-a, DAN-795) over real HTTP with the main database up: the real
// registry checks the migrated PostgreSQL of `pnpm db:migrate` or the CI job
// `database` (project integration-pg), over the public local-only login of
// db/main/local/app-login.sql, no secret. The answer is the `alive-current`
// vector: 200, `state: ok`, no-store, nothing of the URL.
import { readFileSync } from "node:fs";

import { Value } from "@sinclair/typebox/value";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { ROUTES, type VectorFile } from "../contracts/index.ts";

import { createDatabases } from "./databases.ts";
import { createHealthRoute } from "./health.ts";
import { createLayers } from "./pipeline.ts";
import { type Running, startServer } from "./start.ts";

const URL_OF_MAIN =
  process.env.APP_DATABASE_URL ??
  "postgres://ductus_app_local:ductus-app-local-only@127.0.0.1:54329/ductus";
const vectors = JSON.parse(
  readFileSync(new URL("../contracts/vectors/platform.health.get.json", import.meta.url), "utf8"),
) as VectorFile;
const CONTRACT = ROUTES.find((route) => route.id === "platform.health.get");
const ALIVE = vectors.vectors.find((v) => v.name === "alive-current");

const databases = createDatabases();
let running: Running;

beforeAll(async () => {
  vi.stubEnv("APP_DATABASE_URL", URL_OF_MAIN);
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
  await databases.close();
  vi.unstubAllEnvs();
});

describe("health with the main database up, over real HTTP", () => {
  it("answers the alive-current vector, no-store, and nothing of the URL", async () => {
    expect((await databases.health()).main).toBe("ok");
    const response = await fetch(`http://127.0.0.1:${running.port}/api/v1/health`);
    const text = await response.text();
    expect(response.status).toBe(ALIVE?.response.status);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body: unknown = JSON.parse(text);
    expect(body).toEqual(ALIVE?.response.body);
    expect(Value.Check(CONTRACT?.responses[0]?.body as never, body)).toBe(true);
    const { username, password, pathname, port } = new URL(URL_OF_MAIN);
    for (const part of [username, password, pathname.slice(1), port]) {
      expect(text).not.toContain(part);
    }
  });
});

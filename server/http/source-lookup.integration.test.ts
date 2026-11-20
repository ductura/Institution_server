import { afterEach, describe, expect, it, vi } from "vitest";

import type { ActorTransaction, WithActor } from "../database/index.ts";
import { createDatabases } from "./databases.ts";
import { createLayers } from "./pipeline.ts";
import { startServer, type Running } from "./start.ts";

import { createSourceLookupRouteFor } from "./source-lookup.ts";

const ORIGIN = "https://ductura.example.invalid";
const COOKIE = `__Host-ductus_session=${"T".repeat(43)}`;
const BODY = { kind: "doi", identifier: "DOI: 10.99999/Izmisljeni" };
const DEVELOPMENT = {
  NODE_ENV: "development",
  DUCTUS_AUTH_PROVIDER: "fake-oidc",
  ["SOURCE_LOOKUP_CONTACT"]: "operater@example.invalid",
};
let running: Running | undefined;

afterEach(async () => {
  await running?.close();
});

async function open(
  row: { slug?: string; role?: string; expired?: boolean } = {},
  env: NodeJS.ProcessEnv = DEVELOPMENT,
) {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation(async (input) =>
      Response.json(
        String(input).startsWith("https://openlibrary.org/")
          ? {}
          : { message: { title: ["Izmišljeni rad"] } },
      ),
    );
  const withActor: WithActor = async (_token, transact) => {
    if (row.expired) throw Object.assign(new Error("expired fixture"), { code: "ZD401" });
    const actor = {
      ["institution_slug"]: row.slug ?? "demo-fakultet",
      institutionDisplayName: null,
      displayName: null,
      roles: [row.role ?? "student"],
      userId: "00000000-0000-0000-0000-000000000001",
      institutionId: "00000000-0000-0000-0000-000000000002",
    };
    return transact({ query: async () => ({ rows: [actor] }) } as unknown as ActorTransaction);
  };
  running = await startServer({
    host: "127.0.0.1",
    port: 0,
    databases: createDatabases(),
    layers: createLayers({ expectedOrigin: ORIGIN }),
    routes: [createSourceLookupRouteFor({ withActor }, env, fetcher)],
  });
  const send = (body: unknown = BODY, headers: Record<string, string> = {}) =>
    fetch(`http://127.0.0.1:${running?.port}/api/v1/sources/lookup`, {
      method: "POST",
      headers: { origin: ORIGIN, cookie: COOKIE, "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  return { send, fetcher };
}

describe("POST /api/v1/sources/lookup", () => {
  it("returns validated metadata and preserves Retry-After on a repeat", async () => {
    const { send, fetcher } = await open();
    const found = await send();
    expect(found.status).toBe(200);
    expect(found.headers.get("cache-control")).toBe("no-store");
    await expect(found.json()).resolves.toEqual({
      source: { title: "Izmišljeni rad", type: null, authors: [] },
    });
    const limited = await send();
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("1");
    expect(fetcher).toHaveBeenCalledTimes(1);
    const missing = await send({ kind: "isbn", identifier: "9780000000422" });
    expect(missing.status).toBe(200);
    await expect(missing.json()).resolves.toEqual({ source: null });
  });

  it("refuses invalid JSON shape, invalid identifiers, bad origins and missing cookies", async () => {
    const { send, fetcher } = await open();
    expect((await send({ ...BODY, userId: "demo" })).status).toBe(422);
    expect((await send({ kind: "isbn", identifier: "1234567890" })).status).toBe(422);
    expect((await send(BODY, { origin: "https://vanjski.example.invalid" })).status).toBe(403);
    expect((await send(BODY, { cookie: "" })).status).toBe(401);
    expect((await send(BODY, { "content-type": "text/plain" })).status).toBe(415);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    [{ expired: true }, DEVELOPMENT, 401],
    [{ role: "teacher" }, DEVELOPMENT, 403],
    [{ slug: "izmisljeni-fakultet" }, DEVELOPMENT, 403],
    [{ expired: true }, { ...DEVELOPMENT, NODE_ENV: "production" }, 401],
    [{}, { ...DEVELOPMENT, NODE_ENV: "production" }, 503],
    [{}, { ...DEVELOPMENT, NODE_ENV: "test" }, 503],
    [{}, { ...DEVELOPMENT, DUCTUS_AUTH_PROVIDER: "aai-eduhr" }, 503],
    [{}, { ...DEVELOPMENT, ["SOURCE_LOOKUP_CONTACT"]: "invalid\nheader" }, 503],
  ] as const)("keeps egress closed for %j in %j", async (row, env, status) => {
    const { send, fetcher } = await open(row, env);
    expect((await send()).status).toBe(status);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

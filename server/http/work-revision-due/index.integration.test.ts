import { afterEach, expect, it, vi } from "vitest";

import type { WithActor } from "../../database/index.ts";
import { createDatabases, createLayers, startServer, type Running } from "../index.ts";

import { createWorkRevisionDueRoutesFor } from "./index.ts";

const ORIGIN = "https://ductura.example.invalid";
const TOKEN = "E".repeat(43);
const HEADERS = { cookie: `__Host-ductus_session=${TOKEN}` };
const DOCUMENT = "izmisljeni-rad-0001";

let running: Running | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
});

type Query = (sql: string, values?: readonly unknown[]) => Promise<object[]>;

async function fixture(query: Query) {
  const spy = vi.fn(query);
  const withActor: WithActor = async (token, run) => {
    expect(token).toBe(TOKEN);
    return run({
      async query<Row>(sql: string, values?: readonly unknown[]) {
        const rows = await spy(sql, values);
        return { rows: rows as Row[], rowCount: rows.length };
      },
    });
  };
  running = await startServer({
    host: "127.0.0.1",
    port: 0,
    databases: createDatabases(),
    layers: createLayers({ expectedOrigin: ORIGIN }),
    routes: createWorkRevisionDueRoutesFor({ withActor }),
  });
  return {
    url: (id = DOCUMENT) => `http://127.0.0.1:${running!.port}/api/v1/works/${id}/revision-due`,
    spy,
  };
}

// The database answers snake_case keys; built from pairs (naming-convention).
const row = (outcome: string, attempt: number | null, due: Date | null, at: Date | null) => [
  Object.fromEntries([
    ["outcome", outcome],
    ["attempt", attempt],
    ["revision_due_at", due],
    ["returned_at", at],
  ]),
];
const DUE = new Date("2026-12-10T09:00:00.000Z");
const AT = new Date("2026-12-01T10:00:00.000Z");

it("answers the round and the due date of an open return, asking the RPC with the work only", async () => {
  const { url, spy } = await fixture(async () => row("ok", 2, DUE, AT));
  const response = await fetch(url(), { headers: HEADERS });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    returned: { round: 2, revisionDueAt: DUE.toISOString(), returnedAt: AT.toISOString() },
  });
  expect(spy).toHaveBeenCalledTimes(1);
  expect(spy.mock.calls[0]![0]).toContain("app.read_work_revision_due($1)");
  expect(spy.mock.calls[0]![1]).toEqual([DOCUMENT]);
});

it("answers a null due date when the teacher set none", async () => {
  const { url } = await fixture(async () => row("ok", 1, null, AT));
  const response = await fetch(url(), { headers: HEADERS });
  expect(await response.json()).toEqual({
    returned: { round: 1, revisionDueAt: null, returnedAt: AT.toISOString() },
  });
});

it("answers returned null when nothing is open", async () => {
  const { url } = await fixture(async () => row("ok", null, null, null));
  const response = await fetch(url(), { headers: HEADERS });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ returned: null });
});

it("answers 404 for not_found and invalid, the same for everybody with no part in the work", async () => {
  for (const outcome of ["not_found", "invalid"]) {
    const { url } = await fixture(async () => row(outcome, null, null, null));
    const response = await fetch(url(), { headers: HEADERS });
    expect(response.status).toBe(404);
    await running?.close();
    running = undefined;
  }
});

it("answers 404 for a malformed work id without asking the database", async () => {
  const { url, spy } = await fixture(async () => row("ok", null, null, null));
  const response = await fetch(url("%20"), { headers: HEADERS });
  expect(response.status).toBe(404);
  expect(spy).not.toHaveBeenCalled();
});

it("answers 401 without a session and when the database says unauthorized", async () => {
  const { url, spy } = await fixture(async () => row("unauthorized", null, null, null));
  expect((await fetch(url())).status).toBe(401);
  expect(spy).not.toHaveBeenCalled();
  expect((await fetch(url(), { headers: HEADERS })).status).toBe(401);
});

it("answers 503 for a row of an unexpected shape or a database error", async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  for (const query of [
    async () => row("ok", 0.5, DUE, AT),
    async () => row("surprise", null, null, null),
    async () => [],
    async () => {
      throw new Error("down");
    },
  ] as Query[]) {
    const { url } = await fixture(query);
    expect((await fetch(url(), { headers: HEADERS })).status).toBe(503);
    await running?.close();
    running = undefined;
  }
});

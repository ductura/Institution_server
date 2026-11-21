import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";

import type { ActorTransaction, WithActor } from "../../database/index.ts";

import { createDatabases, createLayers, startServer, type Running } from "../index.ts";
import { createMentorNotesRoutesFor } from "./index.ts";

const ORIGIN = "https://ductura.example.invalid";
const TOKEN = "t".repeat(43);
const ID = "00000000-0000-4000-8000-0000000014b1";
const PATH = `/api/v1/mentorships/${ID.toUpperCase()}/notes`;
const BODY = "Izmišljena privatna bilješka.";
const ROW = { id: ID, body: BODY, created_at: new Date("2026-11-21T12:00:00.000Z") };
const query = vi.fn<(sql: string, values?: readonly unknown[]) => unknown[]>();
const withActor: WithActor = (token, run) =>
  run({
    query: async (sql, values) => {
      expect(token).toBe(TOKEN);
      const rows = sql.includes("identity.touch_current_session") ? [] : query(sql, values);
      return { rows, rowCount: rows.length };
    },
  } as ActorTransaction);

let running: Running;
beforeAll(async () => {
  running = await startServer({
    host: "127.0.0.1",
    port: 0,
    databases: createDatabases(),
    layers: createLayers({ expectedOrigin: ORIGIN }),
    routes: createMentorNotesRoutesFor({ withActor }),
  });
});
afterAll(async () => running.close());
beforeEach(() => query.mockReset());

function call(input?: unknown, cookie = TOKEN, site = "same-origin") {
  return fetch(`http://127.0.0.1:${running.port}${PATH}`, {
    headers: {
      ...(cookie ? { cookie: `__Host-ductus_session=${cookie}` } : {}),
      origin: ORIGIN,
      "sec-fetch-site": site,
      "content-type": "application/json",
    },
    ...(input === undefined ? {} : { method: "POST", body: JSON.stringify(input) }),
  });
}

it("creates a note and lists only public contract fields without caching", async () => {
  query
    .mockReturnValueOnce([{ authenticated: true, allowed: true, id: null }])
    .mockReturnValueOnce([ROW])
    .mockReturnValueOnce([{ authenticated: true, allowed: true, ...ROW }]);
  expect(await (await call()).json()).toEqual({ notes: [] });
  const created = await call({ body: BODY });
  expect(created.status).toBe(201);
  expect(created.headers.get("cache-control")).toBe("no-store");
  const note = { id: ID, body: BODY, createdAt: ROW.created_at.toISOString() };
  expect(await created.json()).toEqual(note);
  const listed = await call();
  expect(listed.status).toBe(200);
  expect(listed.headers.get("cache-control")).toBe("no-store");
  expect(await listed.json()).toEqual({ notes: [note] });
  expect(query.mock.calls.map(([, values]) => values)).toEqual([[ID], [ID, BODY], [ID]]);
});

it("returns the same not-found response for an unknown mentorship and one without access", async () => {
  query.mockReturnValueOnce([{ authenticated: true, allowed: null, id: null }]);
  query.mockImplementationOnce(() => {
    throw Object.assign(new Error("forbidden"), { code: "ZD403" });
  });
  for (const response of [await call(), await call({ body: BODY })]) {
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "not_found" });
  }
});

it("rejects missing sessions, cross-site reads and invalid note bodies", async () => {
  expect((await call(undefined, "")).status).toBe(401);
  expect((await call(undefined, TOKEN, "cross-site")).status).toBe(403);
  for (const body of [" \t\n", "\u0000", "\ud800", "a".repeat(4001)]) {
    expect((await call({ body })).status).toBe(422);
  }
  expect((await call({ body: BODY, mentorId: ID })).status).toBe(422);
  expect(query).not.toHaveBeenCalled();
});

import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";

import type { ActorTransaction, WithActor } from "../../database/index.ts";
import { createDatabases, createLayers, startServer, type Running } from "../index.ts";

import { createKeyDatesRoutesFor } from "./index.ts";

const ID = "00000000-0000-4000-8000-0000000017a5";
const TOKEN = "a".repeat(43);
const AT = "2027-03-15T09:00:00.000Z";
const query = vi.fn();
const withActor: WithActor = (token, run) =>
  run({
    query: async (sql, values) => {
      const rows = query(token, sql, values);
      return { rows, rowCount: rows.length };
    },
  } as ActorTransaction);

let server: Running;
beforeAll(async () => {
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    databases: createDatabases(),
    layers: createLayers({ expectedOrigin: "https://ductura.example.invalid" }),
    routes: createKeyDatesRoutesFor({ withActor }),
  });
});
afterAll(async () => server.close());
beforeEach(() => query.mockReset());

function read(id = ID, cookie = `__Host-ductus_session=${TOKEN}`) {
  return fetch(`http://127.0.0.1:${server.port}/api/v1/mentorships/${id}/key-dates`, {
    headers: { cookie },
  });
}

it.each(["", "__Host-ductus_session=bad"])("requires a session cookie (%s)", async (cookie) => {
  expect((await read(ID, cookie)).status).toBe(401);
  expect(query).not.toHaveBeenCalled();
});

it.each(["unknown", `${ID}%0A`, `${ID}%2Fother`])("rejects an invalid id (%s)", async (id) => {
  expect((await read(id)).status).toBe(404);
  expect(query).not.toHaveBeenCalled();
});

it.each([
  [false, false, 401, "unauthorized"],
  [true, false, 404, "not_found"],
])("maps the resolved access state (%s, %s)", async (authenticated, visible, status, code) => {
  query.mockReturnValueOnce([{ authenticated, visible, kind: null }]);
  const response = await read();
  expect(response.status).toBe(status);
  expect(await response.json()).toMatchObject({ code });
});

it("returns the three date kinds in the order supplied by the one actor query", async () => {
  const dates = [
    { kind: "milestone", id: ID, at: AT, title: "🌳".repeat(200) },
    { kind: "consultation", id: ID, at: AT, state: "confirmed" },
    { kind: "deadline", id: ID, at: AT },
  ];
  query.mockReturnValueOnce(
    dates.map((date) => ({ authenticated: true, visible: true, ...date, at: new Date(date.at) })),
  );
  const response = await read(ID.toUpperCase());
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ dates });
  expect(query).toHaveBeenCalledExactlyOnceWith(TOKEN, expect.any(String), [ID.toUpperCase()]);
});

it("returns an empty list for a visible mentorship without any date", async () => {
  query.mockReturnValueOnce([{ authenticated: true, visible: true, kind: null }]);
  const response = await read();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ dates: [] });
});

it("returns a single error if a source fails or the result is outside the contract", async () => {
  query
    .mockImplementationOnce(() => {
      throw new Error("test database unavailable");
    })
    .mockReturnValueOnce([
      { authenticated: true, visible: true, kind: "deadline", id: ID, at: new Date(AT) },
      { authenticated: true, visible: true, kind: "consultation", id: ID, at: new Date(AT) },
    ]);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await read();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "unavailable" });
  }
});

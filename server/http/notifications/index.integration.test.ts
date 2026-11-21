import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { ActorTransaction, WithActor } from "../../database/index.ts";
import { createDatabases, createLayers, startServer, type Running } from "../index.ts";

import { createNotificationsRoutesFor } from "./index.ts";

const ORIGIN = "https://ductura.example.invalid";
const COOKIE = `__Host-ductus_session=${"A".repeat(43)}`;
const ID = "00000000-0000-4000-8000-000000001701";
const AT = "2026-11-21T08:00:00.000Z";
const query = vi.fn<ActorTransaction["query"]>();
const withActor: WithActor = (_token, run) => run({ query: query as ActorTransaction["query"] });
let running: Running;

beforeEach(async () => {
  query.mockReset();
  running = await startServer({
    host: "127.0.0.1",
    port: 0,
    layers: createLayers({ expectedOrigin: ORIGIN }),
    databases: createDatabases(),
    routes: createNotificationsRoutesFor({ withActor }, "900"),
  });
});
afterEach(() => running.close());

const url = (suffix = "") => `http://127.0.0.1:${running.port}/api/v1/notifications${suffix}`;
const get = (suffix = "") => fetch(url(suffix), { headers: { cookie: COOKIE } });
const post = (id = ID, headers = { cookie: COOKIE, origin: ORIGIN }, body?: string) =>
  fetch(url(`/${id}/read`), { method: "POST", headers, ...(body === undefined ? {} : { body }) });

it("bounds the inbox page and passes the configured cooldown with the cursor", async () => {
  const rows = Array.from({ length: 51 }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    targetId: ID,
    kind: "deadline_reminder",
    createdAt: new Date(AT),
    readAt: null,
  }));
  query.mockResolvedValueOnce({ rows, rowCount: rows.length });
  const response = await get(`?before=${ID}`);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({
    notifications: rows.slice(0, 50).map((row) => ({ ...row, createdAt: AT })),
    nextBefore: rows[49]?.id,
  });
  expect(query.mock.calls[0]?.[1]).toEqual([ID, 900]);
});

it.each(["?before=", "?before=wrong", `?before=${ID}&before=${ID}`, `?before=${ID}&userId=${ID}`])(
  "refuses an invalid inbox query %s without calling the port",
  async (suffix) => {
    expect((await get(suffix)).status).toBe(422);
    expect(query).not.toHaveBeenCalled();
  },
);

it("maps refusal of another account's cursor and unknown notification id to 404", async () => {
  query.mockRejectedValueOnce(Object.assign(new Error(), { code: "ZD403" }));
  expect((await get(`?before=${ID}`)).status).toBe(404);
  query.mockResolvedValueOnce({ rows: [{ updated: false }], rowCount: 1 });
  expect((await post()).status).toBe(404);
});

it("marks a notification only with a session and same-origin empty POST", async () => {
  expect((await fetch(url())).status).toBe(401);
  expect((await post(ID, { origin: ORIGIN, cookie: "" })).status).toBe(401);
  expect((await post(ID, { origin: "https://other.example.invalid", cookie: COOKIE })).status).toBe(
    403,
  );
  expect((await post("not-an-id")).status).toBe(404);
  expect((await post(ID, undefined, "payload")).status).toBe(413);
  expect(query).not.toHaveBeenCalled();
  query.mockResolvedValueOnce({ rows: [{ updated: true }], rowCount: 1 });
  expect((await post()).status).toBe(204);
  expect(query.mock.calls[0]?.[1]).toEqual([ID]);
});

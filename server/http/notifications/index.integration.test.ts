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

// SRV-1607: a new kind is not in the inbox contract; it has a list of its own.
it("leaves the returned-for-revision kind out of the inbox but counts it in the page", async () => {
  const row = (i: number, kind: string) => ({
    id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    targetId: ID,
    kind,
    createdAt: new Date(AT),
    readAt: null,
  });
  const rows = Array.from({ length: 51 }, (_, i) =>
    row(i, i === 1 ? "returned_for_revision" : "deadline_reminder"),
  );
  query.mockResolvedValueOnce({ rows, rowCount: rows.length });
  const response = await get();
  expect(response.status).toBe(200);
  const body = (await response.json()) as { notifications: { id: string }[]; nextBefore: string };
  expect(body.notifications).toHaveLength(49);
  expect(body.notifications.map((n) => n.id)).not.toContain(rows[1]?.id);
  expect(body.nextBefore).toBe(rows[49]?.id);
});

const REVISION_ID = "00000000-0000-4000-8000-000000001711";
const revisionRow = (i: number) => ({
  id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
  targetId: ID,
  documentId: "doc-demo-1",
  comment: "Doradi uvod.",
  revisionDueAt: i % 2 === 0 ? "2026-12-15T12:00:00.000Z" : null,
  createdAt: AT,
  readAt: null,
});

it("lists the notifications of returned work with the work, the comment and the new due date", async () => {
  const rows = Array.from({ length: 51 }, (_, i) => ({
    ...revisionRow(i),
    createdAt: new Date(AT),
    revisionDueAt: i % 2 === 0 ? new Date("2026-12-15T12:00:00.000Z") : null,
  }));
  query.mockResolvedValueOnce({ rows, rowCount: rows.length });
  const response = await get(`/returned-for-revision?before=${REVISION_ID}`);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({
    notifications: Array.from({ length: 50 }, (_, i) => revisionRow(i)),
    nextBefore: rows[49]?.id,
  });
  expect(query.mock.calls[0]?.[1]).toEqual([REVISION_ID]);
});

it("answers the returned-for-revision list like the inbox: session, query and cursor", async () => {
  expect((await fetch(url("/returned-for-revision"))).status).toBe(401);
  for (const suffix of ["?before=", "?before=wrong", `?before=${ID}&userId=${ID}`])
    expect((await get(`/returned-for-revision${suffix}`)).status).toBe(422);
  expect(query).not.toHaveBeenCalled();
  query.mockRejectedValueOnce(Object.assign(new Error(), { code: "ZD403" }));
  expect((await get(`/returned-for-revision?before=${ID}`)).status).toBe(404);
  query.mockRejectedValueOnce(new Error("down"));
  expect((await get("/returned-for-revision")).status).toBe(503);
  query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
  expect(await (await get("/returned-for-revision")).json()).toEqual({
    notifications: [],
    nextBefore: null,
  });
});

// GET and PUT /api/v1/works/{documentId}/direct-edit (SRV-1702) on a real
// server with the real pipeline over a scripted transaction: the answers, the
// order of the checks before the database and the closed refusals. The
// database itself is db/main/tests/200-teacher-direct-edit.sql and
// direct-edit.pg.integration.test.ts. All values are invented.
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { ActorTransaction, WithActor } from "../../database/index.ts";
import { createDatabases, createLayers, startServer, type Running } from "../index.ts";

import { createDirectEditRoutesFor } from "./index.ts";

const ORIGIN = "https://ductura.example.invalid";
const TOKEN = "A".repeat(43);
const AT = new Date("2026-11-21T09:00:00.000Z");

const query = vi.fn<ActorTransaction["query"]>();
const withActor: WithActor = (_token, run) => run({ query: query as ActorTransaction["query"] });
let server: Running;

beforeEach(async () => {
  query.mockReset();
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    layers: createLayers({ expectedOrigin: ORIGIN }),
    databases: createDatabases(),
    routes: createDirectEditRoutesFor({ withActor }),
  });
});
afterEach(() => server.close());

const url = (id = "izmisljeni-rad") =>
  `http://127.0.0.1:${server.port}/api/v1/works/${id}/direct-edit`;
const cookie = { cookie: `__Host-ductus_session=${TOKEN}` };
const put = (body: string, headers: Record<string, string> = {}) =>
  fetch(url(), {
    method: "PUT",
    headers: { origin: ORIGIN, "content-type": "application/json", ...cookie, ...headers },
    body,
  });
const rows = (list: Record<string, unknown>[]) => ({ rows: list, rowCount: list.length });

it("reads the setting and the record, the teacher's edits marked as the teacher's", async () => {
  query.mockResolvedValueOnce(rows([{ mode: "direct", changedAt: AT }])).mockResolvedValueOnce(
    rows([
      { kind: "mode", source: "student", mode: "direct", bytes: null, at: AT },
      { kind: "teacher_edit", source: "teacher", mode: null, bytes: 412, at: AT },
    ]),
  );
  const response = await fetch(url(), { headers: cookie });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    mode: "direct",
    changedAt: AT.toISOString(),
    record: [
      { kind: "mode", source: "student", mode: "direct", at: AT.toISOString() },
      { kind: "teacher_edit", source: "teacher", bytes: 412, at: AT.toISOString() },
    ],
  });
  expect(query.mock.calls.map((c) => c[1])).toEqual([["izmisljeni-rad"], ["izmisljeni-rad"]]);
});

it("sets the mode and answers the outcome", async () => {
  query.mockResolvedValueOnce(rows([{ outcome: "applied", mode: "suggestions", changedAt: AT }]));
  const response = await put(JSON.stringify({ mode: "suggestions" }));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    outcome: "applied",
    mode: "suggestions",
    changedAt: AT.toISOString(),
  });
  expect(query.mock.calls[0]![1]).toEqual(["izmisljeni-rad", "suggestions"]);
});

it.each([
  ["another case", { mode: "Direct" }],
  ["an unknown mode", { mode: "on" }],
  ["a boolean", { mode: true }],
  ["null", { mode: null }],
  ["no mode", {}],
  ["an unknown key", { mode: "direct", userId: "izmisljeni" }],
])("refuses %s with 422 and never reaches the database", async (_name, body) => {
  expect((await put(JSON.stringify(body))).status).toBe(422);
  expect(query).not.toHaveBeenCalled();
});

it("refuses a missing session, a wrong media type, broken JSON and a foreign origin first", async () => {
  expect((await fetch(url())).status).toBe(401);
  expect((await put("{}", { cookie: "" })).status).toBe(401);
  expect((await put("{}", { "content-type": "text/plain" })).status).toBe(415);
  expect((await put("{")).status).toBe(400);
  expect((await put("{}", { origin: "https://drugi.example.invalid" })).status).toBe(403);
  expect((await put(JSON.stringify({ mode: "direct" }).padEnd(1025, " "))).status).toBe(413);
  expect(query).not.toHaveBeenCalled();
});

it("answers 404 for a relation the database refuses, 401 for a closed session and 503 for a fault", async () => {
  const code = (c: string) => Object.assign(new Error("izmišljeno"), { code: c });
  query.mockRejectedValueOnce(code("ZD403"));
  expect((await fetch(url(), { headers: cookie })).status).toBe(404);
  query.mockRejectedValueOnce(code("ZD403"));
  expect((await put(JSON.stringify({ mode: "direct" }))).status).toBe(404);
  query.mockRejectedValueOnce(code("ZD401"));
  expect((await put(JSON.stringify({ mode: "direct" }))).status).toBe(401);
  query.mockRejectedValueOnce(code("ZD422"));
  expect((await put(JSON.stringify({ mode: "direct" }))).status).toBe(422);
  query.mockRejectedValueOnce(new Error("boom"));
  expect((await fetch(url(), { headers: cookie })).status).toBe(503);
});

it("answers an impossible work id with 404 unread", async () => {
  expect((await fetch(url("%20rad"), { headers: cookie })).status).toBe(404);
  expect((await fetch(url("x".repeat(257)), { headers: cookie })).status).toBe(404);
  expect(query).not.toHaveBeenCalled();
});

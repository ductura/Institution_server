import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { ActorTransaction, WithActor } from "../../database/index.ts";
import { createDatabases, createLayers, startServer, type Running } from "../index.ts";

import { createWorkMessagesRoutesFor } from "./index.ts";

const ORIGIN = "https://ductura.example.invalid";
const TOKEN = "A".repeat(43);
const ID = "7b6c5d4e-3f2a-4b1c-8d9e-0a1b2c3d4e01";
const AT = new Date("2026-11-21T09:00:00.000Z");
const ROW = { id: ID, senderRole: "student", text: "Izmišljena poruka.", createdAt: AT };
const MESSAGE = { ...ROW, createdAt: AT.toISOString() };

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
    routes: createWorkMessagesRoutesFor({ withActor }),
  });
});
afterEach(() => server.close());

const url = (id = "izmisljeni-rad") =>
  `http://127.0.0.1:${server.port}/api/v1/works/${id}/messages`;
const cookie = { cookie: `__Host-ductus_session=${TOKEN}` };
const post = (body: string, headers: Record<string, string> = {}) =>
  fetch(url(), {
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/json", ...cookie, ...headers },
    body,
  });

it("lists the conversation with no request body", async () => {
  query.mockResolvedValueOnce({ rows: [ROW], rowCount: 1 });
  const response = await fetch(url(), { headers: cookie });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ messages: [MESSAGE] });
});

it("answers an empty conversation", async () => {
  query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
  expect(await (await fetch(url(), { headers: cookie })).json()).toEqual({ messages: [] });
});

it("stores a message and answers 201 with it", async () => {
  query.mockResolvedValueOnce({ rows: [ROW], rowCount: 1 });
  const response = await post(JSON.stringify({ text: "Izmišljena poruka." }));
  expect(response.status).toBe(201);
  expect(await response.json()).toEqual(MESSAGE);
  expect(query.mock.calls[0]![1]).toEqual(["izmisljeni-rad", "Izmišljena poruka."]);
});

it.each([
  ["empty", { text: "" }],
  ["blank", { text: "  \n " }],
  ["unknown key", { text: "x", extra: 1 }],
  ["no text", {}],
  ["control character", { text: "a\u0000b" }],
  ["bidi override", { text: "a‮b" }],
  ["not normalized", { text: "é" }],
])("refuses a %s message and never reaches the database", async (_name, body) => {
  expect((await post(JSON.stringify(body))).status).toBe(422);
  expect(query).not.toHaveBeenCalled();
});

it("refuses a missing session, a wrong media type and broken JSON", async () => {
  expect((await fetch(url())).status).toBe(401);
  expect((await post("{}", { "content-type": "text/plain" })).status).toBe(415);
  expect((await post("{")).status).toBe(400);
  expect(query).not.toHaveBeenCalled();
});

it("answers 404 for a relation the database refuses and 503 for a fault", async () => {
  query.mockRejectedValueOnce(Object.assign(new Error("x"), { code: "ZD403" }));
  expect((await fetch(url(), { headers: cookie })).status).toBe(404);
  query.mockRejectedValueOnce(new Error("boom"));
  expect((await fetch(url(), { headers: cookie })).status).toBe(503);
});

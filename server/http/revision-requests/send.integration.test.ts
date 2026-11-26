// SRV-ED43-DORADA-POSALJI: the HTTP edge of POST /api/v1/revision-send. The
// database is a stand-in here; who may send, which round and the repeated send
// are proven against PostgreSQL in db/main/tests/258-collaboration-revision-send.sql.
// Every id and text is invented.
import { readFileSync } from "node:fs";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { ActorTransaction, WithActor } from "../../database/index.ts";
import { createDatabases, createLayers, startServer, type Running } from "../index.ts";

import { createRevisionSendRouteFor } from "./send.ts";

type Vector = {
  name: string;
  request: { body?: Record<string, unknown>; rawBody?: string };
  response: { status: number; body: Record<string, unknown> };
};
const VECTORS = (
  JSON.parse(
    readFileSync(
      new URL("../../contracts/vectors/collaboration.revision-send.post.json", import.meta.url),
      "utf8",
    ),
  ) as { vectors: Vector[] }
).vectors;
const vector = (name: string) => VECTORS.find((entry) => entry.name === name)!;

const ORIGIN = "https://ductura.example.invalid";
const TOKEN = "S".repeat(43);
const WORK = "izmisljeni-rad-0001";

const query = vi.fn<ActorTransaction["query"]>();
const actor = vi.fn<(token: string | null | undefined) => void>();
const withActor: WithActor = (token, run) => {
  actor(token);
  return run({ query: query as ActorTransaction["query"] });
};
let server: Running;

beforeEach(async () => {
  query.mockReset();
  actor.mockReset();
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    layers: createLayers({ expectedOrigin: ORIGIN }),
    databases: createDatabases(),
    routes: [createRevisionSendRouteFor({ withActor })],
  });
});
afterEach(() => server.close());

function post(
  body: string,
  { token = TOKEN as string | null, type = "application/json", origin = ORIGIN } = {},
) {
  return fetch(`http://127.0.0.1:${server.port}/api/v1/revision-send`, {
    method: "POST",
    headers: {
      origin,
      ...(token === null ? {} : { cookie: `__Host-ductus_session=${token}` }),
      "content-type": type,
    },
    body,
  });
}

/** `{documentId, message}` as its canonical bytes (sorted keys, no spaces). */
const body = (message: unknown, documentId: unknown = WORK) =>
  JSON.stringify({ documentId, message });
const round = (value: unknown) =>
  query.mockResolvedValueOnce({ rows: [{ round: value }], rowCount: 1 });

it("sends the revision: the round of the vector, under the session of the cookie, the message as sent", async () => {
  const { request, response } = vector("sent");
  round(2);
  const result = await post(JSON.stringify(request.body));
  expect(result.status).toBe(200);
  expect(await result.json()).toEqual(response.body);
  expect(result.headers.get("cache-control")).toBe("no-store");
  expect(actor.mock.calls).toEqual([[TOKEN]]);
  expect(query.mock.calls).toEqual([
    [
      "SELECT round FROM collaboration.send_revision($1, $2)",
      [request.body!.documentId, request.body!.message],
    ],
  ]);
});

it("a send without a message passes null, never an empty text", async () => {
  round(1);
  const result = await post(body(null));
  expect(result.status).toBe(200);
  expect(await result.json()).toEqual({ round: 1 });
  expect(query.mock.calls[0]?.[1]).toEqual([WORK, null]);
});

it.each([
  ["ZD401", 401, "unauthorized"],
  ["ZD403", 403, "forbidden"],
  ["ZD404", 404, "not_found"],
  ["ZD409", 409, "not_allowed"],
  ["ZD422", 422, "invalid_input"],
])("the database refusal %s is %i %s", async (code, status, error) => {
  query.mockRejectedValueOnce(Object.assign(new Error("x"), { code }));
  const result = await post(body(null));
  expect(result.status).toBe(status);
  expect(((await result.json()) as { error: string }).error).toBe(error);
});

it("a foreign work (the database's not found) is the 404 of the vector, as a missing one", async () => {
  query.mockRejectedValueOnce(Object.assign(new Error("x"), { code: "ZD404" }));
  const { request, response } = vector("not-found");
  const result = await post(JSON.stringify(request.body));
  expect(result.status).toBe(404);
  expect(((await result.json()) as { error: string }).error).toBe(response.body.error);
});

it.each([
  ["an empty id", body(null, "")],
  ["an id with a control character", body(null, "rad\u0001")],
  ["an id that is a number", body(null, 7)],
])("%s reads as a missing work: 404 before the database", async (_name, text) => {
  const result = await post(text);
  expect(result.status).toBe(404);
  expect(query).not.toHaveBeenCalled();
});

it.each([
  ["spaces, not the canonical bytes", `{ "documentId": "${WORK}", "message": null }`],
  ["the keys out of order", `{"message":null,"documentId":"${WORK}"}`],
  ["an extra key", JSON.stringify({ documentId: WORK, message: null, round: 3 })],
  ["no message key", JSON.stringify({ documentId: WORK })],
  ["a duplicate key", `{"documentId":"${WORK}","documentId":"drugi","message":null}`],
  ["an array", "[]"],
  ["an empty message (null is none)", body("")],
  ["a message of blanks", body(" \u00a0\u200b")],
  ["a message above 2000 characters", body("a".repeat(2001))],
  ["a message with a control character", body("a\u0007b")],
  ["a message with a bidi override", body("a\u202eb")],
  ["a message that is not NFC", body("e\u0301")],
  ["a message that is not text", body(5)],
])("%s is 422 before the database", async (_name, text) => {
  const result = await post(text);
  expect(result.status).toBe(422);
  expect(query).not.toHaveBeenCalled();
});

it("a message of exactly 2000 characters, with newline and tab, is sent", async () => {
  round(1);
  const text = `${"a".repeat(1998)}\n\t`;
  expect((await post(body(text))).status).toBe(200);
  expect(query.mock.calls[0]?.[1]).toEqual([WORK, text]);
});

it.each([
  ["a round of 0", 0],
  ["a round as text", "1"],
  ["a round above 1000", 1001],
])("%s from the database is 503, never passed on", async (_name, value) => {
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    round(value);
    expect((await post(body(null))).status).toBe(503);
  } finally {
    log.mockRestore();
  }
});

it("no row, or a failing database, is 503 and nothing of the failure leaves", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    expect((await post(body(null))).status).toBe(503);
    query.mockRejectedValueOnce(new Error("secret detail"));
    const result = await post(body("Izmišljena poruka."));
    expect(result.status).toBe(503);
    const text = JSON.stringify(await result.json());
    expect(text).not.toContain("secret");
    expect(log.mock.calls.flat().join(" ")).not.toContain("Izmišljena");
  } finally {
    log.mockRestore();
  }
});

it("no session cookie is 401 and the database is not asked", async () => {
  expect((await post(body(null), { token: null })).status).toBe(401);
  expect(actor).not.toHaveBeenCalled();
});

it("another origin is refused by the layer", async () => {
  const result = await post(body(null), { origin: "https://drugo.example.invalid" });
  expect(result.status).toBe(403);
  expect(query).not.toHaveBeenCalled();
});

it("another media type is 415, a body that is not JSON 400, a body over 16 KiB 413", async () => {
  expect((await post(body(null), { type: "text/plain" })).status).toBe(415);
  expect((await post("{")).status).toBe(400);
  expect((await post("x".repeat(16 * 1024 + 1))).status).toBe(413);
  expect(query).not.toHaveBeenCalled();
});

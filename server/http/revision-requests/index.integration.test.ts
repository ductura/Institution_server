import { readFileSync } from "node:fs";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { ActorTransaction, WithActor } from "../../database/index.ts";
import { createDatabases, createLayers, startServer, type Running } from "../index.ts";

import { createRevisionRequestsRouteFor } from "./index.ts";

type Vector = {
  name: string;
  kind: string;
  request: { params: { action: string }; body?: Record<string, unknown> };
  response: { status: number; body: Record<string, unknown> };
};
const VECTORS = (
  JSON.parse(
    readFileSync(
      new URL("../../contracts/vectors/collaboration.revision-requests.post.json", import.meta.url),
      "utf8",
    ),
  ) as { vectors: Vector[] }
).vectors;
const vector = (name: string) => VECTORS.find((entry) => entry.name === name)!;

const ORIGIN = "https://ductura.example.invalid";
const TOKEN = "R".repeat(43);

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
    routes: [createRevisionRequestsRouteFor({ withActor })],
  });
});
afterEach(() => server.close());

function post(
  action: string,
  body: string,
  { token = TOKEN as string | null, type = "application/json", origin = ORIGIN } = {},
) {
  return fetch(`http://127.0.0.1:${server.port}/api/v1/revision-requests/${action}`, {
    method: "POST",
    headers: {
      origin,
      ...(token === null ? {} : { cookie: `__Host-ductus_session=${token}` }),
      "content-type": type,
    },
    body,
  });
}

/** The body of a vector as its canonical JCS bytes (sorted keys, no spaces). */
const sorted = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(sorted)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .map(([key, inner]) => [key, sorted(inner)]),
        )
      : value;
const canonical = (value: unknown) => JSON.stringify(sorted(value));
const bodyOf = (name: string) => canonical(vector(name).request.body);
const withdrawBody = canonical({
  expectedSeq: 1,
  requestId: "8b7a6c5d-4e3f-4a2b-9c1d-0e9f8a7b6c01",
});

it("creates a request: the answer is the one of the vector, under the session of the cookie", async () => {
  const { response, request } = vector("created");
  query.mockResolvedValueOnce({
    rows: [{ request_id: response.body.request_id, row_seq: "1", version: 1, state: "open" }],
    rowCount: 1,
  });
  const result = await post("create", bodyOf("created"));
  expect(result.status).toBe(200);
  expect(await result.json()).toEqual(response.body);
  expect(actor.mock.calls).toEqual([[TOKEN]]);
  expect(query.mock.calls[0]?.[0]).toContain("collaboration.create_revision_request(");
  expect(query.mock.calls[0]?.[1]).toEqual([
    request.body!.documentId,
    canonical(request.body!.anchor),
    request.body!.instruction,
    request.body!.requestedRevision,
  ]);
});

it("answers a transition with the outcome applied", async () => {
  query.mockResolvedValueOnce({
    rows: [{ outcome: "applied", row_seq: "3", version: 1, state: "responded" }],
    rowCount: 1,
  });
  const result = await post("respond", bodyOf("applied"));
  expect(result.status).toBe(200);
  expect(await result.json()).toEqual({
    outcome: "applied",
    row_seq: 3,
    version: 1,
    state: "responded",
  });
});

it("a stale counter is the answer 409 with the current state, not a problem", async () => {
  query.mockResolvedValueOnce({
    rows: [{ outcome: "conflict", row_seq: "3", version: 1, state: "responded" }],
    rowCount: 1,
  });
  const result = await post("withdraw", withdrawBody);
  expect(result.status).toBe(409);
  expect(await result.json()).toEqual({
    outcome: "conflict",
    row_seq: 3,
    version: 1,
    state: "responded",
  });
});

it("lists the requests with every column named as the contract names it", async () => {
  const wanted = vector("listed").response.body.requests as Record<string, unknown>[];
  const date = (value: unknown) => (value === null ? null : new Date(value as string));
  const big = (value: unknown) => (value === null ? null : String(value));
  const rows = wanted.map((entry) => ({
    ...entry,
    request_row_seq: big(entry.request_row_seq),
    requested_revision: big(entry.requested_revision),
    response_revision: big(entry.response_revision),
    accepted_revision: big(entry.accepted_revision),
    opened_window: date(entry.opened_window),
    response_window: date(entry.response_window),
    closed_window: date(entry.closed_window),
  }));
  query.mockResolvedValueOnce({ rows, rowCount: rows.length });
  const result = await post("list", bodyOf("listed"));
  expect(result.status).toBe(200);
  expect(await result.json()).toEqual(vector("listed").response.body);
  expect(result.headers.get("cache-control")).toBe("no-store");
});

it.each([
  ["ZD401", 401, "unauthorized"],
  ["ZD403", 403, "forbidden"],
  ["ZD409", 409, "not_allowed"],
  ["ZD422", 422, "invalid_input"],
])("the database refusal %s is %i %s", async (code, status, error) => {
  query.mockRejectedValueOnce(Object.assign(new Error("x"), { code }));
  const result = await post("withdraw", withdrawBody);
  expect(result.status).toBe(status);
  expect(((await result.json()) as { error: string }).error).toBe(error);
});

it("a failing database is 503 and nothing of the failure leaves", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    query.mockRejectedValueOnce(new Error("secret detail"));
    const result = await post("withdraw", withdrawBody);
    expect(result.status).toBe(503);
    expect(JSON.stringify(await result.json())).not.toContain("secret");
  } finally {
    log.mockRestore();
  }
});

it("a malformed row is 503, never passed on", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    query.mockResolvedValueOnce({ rows: [{ outcome: "other" }], rowCount: 1 });
    expect((await post("withdraw", withdrawBody)).status).toBe(503);
  } finally {
    log.mockRestore();
  }
});

it("an unknown action is 404 before any database work", async () => {
  expect((await post("nepoznato", withdrawBody)).status).toBe(404);
  expect(query).not.toHaveBeenCalled();
});

it("no session cookie is 401 and the database is not asked", async () => {
  expect((await post("withdraw", withdrawBody, { token: null })).status).toBe(401);
  expect(actor).not.toHaveBeenCalled();
});

it("another origin is refused by the layer", async () => {
  const result = await post("withdraw", withdrawBody, { origin: "https://other.example.invalid" });
  expect(result.status).toBe(403);
  expect(query).not.toHaveBeenCalled();
});

it("another media type is 415", async () => {
  expect((await post("withdraw", withdrawBody, { type: "text/plain" })).status).toBe(415);
});

it("a body that is not JSON is 400", async () => {
  expect((await post("withdraw", "{")).status).toBe(400);
});

it.each([
  [
    "spaces, not the canonical bytes",
    `{ "expectedSeq": 1, "requestId": "8b7a6c5d-4e3f-4a2b-9c1d-0e9f8a7b6c01" }`,
  ],
  [
    "an extra key",
    canonical({ expectedSeq: 1, requestId: "8b7a6c5d-4e3f-4a2b-9c1d-0e9f8a7b6c01", x: 1 }),
  ],
  [
    "a duplicate key",
    `{"expectedSeq":1,"expectedSeq":2,"requestId":"8b7a6c5d-4e3f-4a2b-9c1d-0e9f8a7b6c01"}`,
  ],
])("%s is 422", async (_name, text) => {
  const result = await post("withdraw", text);
  expect(result.status).toBe(422);
  expect(query).not.toHaveBeenCalled();
});

it("a malformed id reads as a foreign one: 403", async () => {
  const result = await post("withdraw", canonical({ expectedSeq: 1, requestId: "nije-id" }));
  expect(result.status).toBe(403);
  expect(query).not.toHaveBeenCalled();
});

it("a body over 16 KiB is 413", async () => {
  expect((await post("withdraw", "x".repeat(16 * 1024 + 1))).status).toBe(413);
  expect(query).not.toHaveBeenCalled();
});

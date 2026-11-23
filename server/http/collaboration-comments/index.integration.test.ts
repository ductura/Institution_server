import { createHash } from "node:crypto";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { ActorTransaction, WithActor } from "../../database/index.ts";
import { createDatabases, createLayers, startServer, type Running } from "../index.ts";

import { createCollaborationCommentsRouteFor } from "./index.ts";

const ORIGIN = "https://ductura.example.invalid";
const STUDENT = "A".repeat(43);
const TEACHER = "B".repeat(43);
const ID = "6a5b4c3d-2e1f-4a0b-9c8d-7e6f5a4b3c01";
const NODE = "0f1e2d3c-4b5a-4968-8776-655443322110";
const TEXT = "📚 Izmišljeni odlomak rada";
const SNAPSHOT = JSON.stringify({
  nodes: [{ children: [{ marks: [], text: TEXT, type: "text" }], id: NODE, type: "paragraph" }],
  schemaVersion: 1,
});
const HASH = createHash("sha256").update(SNAPSHOT).digest("hex");
const INPUT = {
  documentId: "izmisljeni-rad",
  body: "Dopuni izvor.",
  anchor: {
    nodeId: NODE,
    quote: "odlomak",
    startHint: TEXT.indexOf("odlomak"),
    endHint: TEXT.indexOf("odlomak") + "odlomak".length,
    prefix: "Izmišljeni ",
    suffix: " rada",
  },
};

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
    routes: [createCollaborationCommentsRouteFor({ withActor })],
  });
});
afterEach(() => server.close());

function post(action: string, body: unknown, token = TEACHER, origin = ORIGIN) {
  return fetch(`http://127.0.0.1:${server.port}/api/v1/comments/${action}`, {
    method: "POST",
    headers: {
      origin,
      cookie: `__Host-ductus_session=${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

it.each(["state", "submitted"])(
  "checks an anchor against the %s revision before creating it",
  async (outcome) => {
    query
      .mockResolvedValueOnce({ rows: [{ outcome, hash: HASH, body: SNAPSHOT }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: ID }], rowCount: 1 });
    const result = await post("create", INPUT);
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ id: ID });
    expect(actor.mock.calls).toEqual([[TEACHER]]);
    expect(query.mock.calls).toEqual([
      [expect.stringContaining("collaboration.read_live_state("), [INPUT.documentId]],
      [
        expect.stringContaining("collaboration.create_comment("),
        [INPUT.documentId, INPUT.body, JSON.stringify(INPUT.anchor), null],
      ],
    ]);
  },
);

it.each([{ quote: "odsjeci" }, { nodeId: ID }, { prefix: "drukčiji " }])(
  "refuses an anchor that no longer matches the revision (%j)",
  async (change) => {
    query.mockResolvedValueOnce({
      rows: [{ outcome: "state", hash: HASH, body: SNAPSHOT }],
      rowCount: 1,
    });
    const result = await post("create", { ...INPUT, anchor: { ...INPUT.anchor, ...change } });
    expect(result.status).toBe(409);
    expect(query).toHaveBeenCalledTimes(1);
  },
);

it("creates a general comment without reading the work", async () => {
  query.mockResolvedValueOnce({ rows: [{ id: ID }], rowCount: 1 });
  expect((await post("create", { ...INPUT, anchor: null })).status).toBe(200);
  expect(query.mock.calls).toEqual([
    [
      expect.stringContaining("collaboration.create_general_comment("),
      [INPUT.documentId, INPUT.body, null],
    ],
  ]);
});

it.each([
  [{ outcome: "empty" }, 409],
  [{ outcome: "state", hash: "0".repeat(64), body: SNAPSHOT }, 503],
] as const)("does not write a comment without a verifiable revision", async (revision, status) => {
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    query.mockResolvedValueOnce({ rows: [revision], rowCount: 1 });
    expect((await post("create", INPUT)).status).toBe(status);
    expect(query).toHaveBeenCalledTimes(1);
  } finally {
    log.mockRestore();
  }
});

it("lists shared comments under each session with no cache", async () => {
  const window = "2026-11-03T10:05:00.000Z";
  const comment = {
    threadId: ID,
    commentId: ID,
    position: 1,
    authorRole: "teacher",
    isOwn: false,
    body: INPUT.body,
    anchor: null,
    state: "open",
    createdWindow: window,
    deletedWindow: null,
    revision: 2,
  };
  for (const token of [TEACHER, STUDENT]) {
    const expected = { ...comment, isOwn: token === TEACHER };
    query.mockResolvedValueOnce({
      // node-postgres hands a bigint over as a string.
      rows: [{ ...expected, createdWindow: new Date(window), revision: "2" }],
      rowCount: 1,
    });
    const result = await post("list", { documentId: INPUT.documentId }, token);
    expect(result.status).toBe(200);
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(await result.json()).toEqual({ comments: [expected] });
  }
  expect(actor.mock.calls).toEqual([[TEACHER], [STUDENT]]);
  expect(query.mock.calls).toEqual(
    Array(2).fill([expect.stringContaining("collaboration.list_comments("), [INPUT.documentId]]),
  );
});

it.each([
  ["reply", { threadId: ID, body: INPUT.body }, "reply_comment", [ID, INPUT.body], 200],
  ["resolve", { threadId: ID }, "resolve_thread", [ID], 204],
  ["reopen", { threadId: ID }, "reopen_thread", [ID], 204],
  ["delete", { commentId: ID }, "delete_comment", [ID], 204],
] as const)("routes %s to its own RPC", async (action, payload, rpc, args, status) => {
  query.mockResolvedValueOnce({ rows: [{ id: ID }], rowCount: 1 });
  const result = await post(action, payload, STUDENT);
  expect(result.status).toBe(status);
  expect(query.mock.calls).toEqual([[expect.stringContaining(`collaboration.${rpc}(`), args]]);
});

it("rejects cross-origin, anonymous, unknown actions and bodies for a different action", async () => {
  expect((await post("create", INPUT, TEACHER, "https://drugi.invalid")).status).toBe(403);
  expect((await post("create", INPUT, "")).status).toBe(401);
  expect((await post("toString", INPUT)).status).toBe(404);
  expect((await post("list", INPUT)).status).toBe(422);
  expect((await post("create", { ...INPUT, authorRole: "teacher" })).status).toBe(422);
  expect((await post("create", { ...INPUT, body: "Dopuni\u0000izvor." })).status).toBe(422);
  expect((await post("create", { ...INPUT, anchor: undefined })).status).toBe(422);
  expect(actor).not.toHaveBeenCalled();
});

it.each(["create", "list"])("uses the database's access decision for %s", async (action) => {
  query.mockRejectedValueOnce(Object.assign(new Error("private detail"), { code: "ZD403" }));
  const result = await post(action, action === "create" ? INPUT : { documentId: INPUT.documentId });
  expect(result.status).toBe(403);
  expect(await result.json()).toMatchObject({ code: "forbidden" });
  expect(query).toHaveBeenCalledTimes(1);
});

// INT-15-SRV: the revision of a new thread goes to the RPC, which requires it
// from a teacher and checks it after the relation; the wire refuses a malformed one.
it("passes the revision of a new anchored thread to create_comment", async () => {
  query
    .mockResolvedValueOnce({
      rows: [{ outcome: "state", hash: HASH, body: SNAPSHOT }],
      rowCount: 1,
    })
    .mockResolvedValueOnce({ rows: [{ id: ID }], rowCount: 1 });
  expect((await post("create", { ...INPUT, revision: 3 })).status).toBe(200);
  expect(query.mock.calls[1]).toEqual([
    expect.stringContaining("collaboration.create_comment("),
    [INPUT.documentId, INPUT.body, JSON.stringify(INPUT.anchor), 3],
  ]);
});

it("passes the revision of a new general thread to create_general_comment", async () => {
  query.mockResolvedValueOnce({ rows: [{ id: ID }], rowCount: 1 });
  expect((await post("create", { ...INPUT, anchor: null, revision: 3 })).status).toBe(200);
  expect(query.mock.calls).toEqual([
    [
      expect.stringContaining("collaboration.create_general_comment("),
      [INPUT.documentId, INPUT.body, 3],
    ],
  ]);
});

it("refuses a malformed revision and a revision outside create before the database", async () => {
  for (const revision of [0, -1, 1.5, "2", null, Number.MAX_SAFE_INTEGER + 1]) {
    expect((await post("create", { ...INPUT, revision })).status).toBe(422);
  }
  expect((await post("reply", { threadId: ID, body: INPUT.body, revision: 2 })).status).toBe(422);
  expect((await post("list", { documentId: INPUT.documentId, revision: 2 })).status).toBe(422);
  expect(actor).not.toHaveBeenCalled();
});

it("answers a missing or wrong revision as the database decides it: 422", async () => {
  query.mockRejectedValueOnce(Object.assign(new Error("private detail"), { code: "ZD422" }));
  const result = await post("create", { ...INPUT, anchor: null, revision: 99 });
  expect(result.status).toBe(422);
  expect(await result.json()).toMatchObject({ code: "invalid_input" });
});

it("lists a thread written before revisions with a null revision", async () => {
  const row = {
    threadId: ID,
    commentId: ID,
    position: 1,
    authorRole: "student",
    isOwn: true,
    body: INPUT.body,
    anchor: null,
    state: "answered",
    createdWindow: new Date("2026-11-03T10:05:00.000Z"),
    deletedWindow: null,
    revision: null,
  };
  query.mockResolvedValueOnce({ rows: [row], rowCount: 1 });
  const result = await post("list", { documentId: INPUT.documentId }, STUDENT);
  expect(await result.json()).toEqual({
    comments: [{ ...row, createdWindow: "2026-11-03T10:05:00.000Z" }],
  });
});

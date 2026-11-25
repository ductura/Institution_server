import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCommentDelay, createTeacherNotes } from "../../database/index.ts";
import type { ActorTransaction, WithActor } from "../../database/index.ts";
import { createDatabases, createLayers, startServer, type Running } from "../index.ts";

import {
  createCommentBankRoutes,
  createCommentDraftRoutes,
  createWorkReviewRoutes,
} from "./index.ts";

const ORIGIN = "https://ductura.example.invalid";
const TOKEN = "A".repeat(43);
const ID = "7b6c5d4e-3f2a-4b1c-8d9e-0a1b2c3d4e01";
const ID2 = "7b6c5d4e-3f2a-4b1c-8d9e-0a1b2c3d4e02";
const AT = new Date("2026-11-21T09:00:00.000Z");
const ANCHOR = { nodeId: ID, quote: "odlomak", prefix: "", suffix: "", startHint: 0, endHint: 7 };

const query = vi.fn<ActorTransaction["query"]>();
const compare = vi.fn();
const withActor: WithActor = (_token, run) => run({ query: query as ActorTransaction["query"] });
let server: Running;

beforeEach(async () => {
  query.mockReset();
  compare.mockReset();
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    layers: createLayers({ expectedOrigin: ORIGIN }),
    databases: createDatabases(),
    routes: [
      ...createCommentDraftRoutes(createCommentDelay(withActor)),
      ...createCommentBankRoutes(createTeacherNotes(withActor)),
      ...createWorkReviewRoutes(createCommentDelay(withActor), () => ({ compare })),
    ],
  });
});
afterEach(() => server.close());

const base = () => `http://127.0.0.1:${server.port}/api/v1`;
const cookie = { cookie: `__Host-ductus_session=${TOKEN}` };
const send = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base()}${path}`, {
    method,
    headers: {
      origin: ORIGIN,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...cookie,
      ...headers,
    },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
const DRAFTS = "/works/izmisljeni-rad/comment-drafts";
const rows = (...r: Record<string, unknown>[]) => ({ rows: r, rowCount: r.length });

it("lists the caller's drafts, the same rows with the window as an ISO instant", async () => {
  query.mockResolvedValueOnce(
    rows({
      threadId: ID,
      commentId: ID,
      position: 1,
      text: "Izmišljena napomena.",
      anchor: ANCHOR,
      state: "open",
      createdWindow: AT,
    }),
  );
  const response = await fetch(`${base()}${DRAFTS}`, { headers: cookie });
  expect(response.status).toBe(200);
  const { drafts } = (await response.json()) as { drafts: { createdWindow: string }[] };
  expect(drafts).toHaveLength(1);
  expect(drafts[0]!.createdWindow).toBe("2026-11-21T09:00:00.000Z");
});

it("opens a draft thread with an anchor and drafts a reply with a thread id", async () => {
  query.mockResolvedValueOnce(rows({ id: ID }));
  const opened = await send("POST", DRAFTS, { text: "Izmišljena napomena.", anchor: ANCHOR });
  expect(opened.status).toBe(201);
  expect(await opened.json()).toEqual({ threadId: ID });
  expect(query.mock.calls[0]![1]).toEqual([
    "izmisljeni-rad",
    "Izmišljena napomena.",
    JSON.stringify(ANCHOR),
  ]);
  query.mockResolvedValueOnce(rows({ id: ID }));
  const reply = await send("POST", DRAFTS, { threadId: ID, text: "Izmišljen odgovor." });
  expect(reply.status).toBe(201);
  expect(await reply.json()).toEqual({ commentId: ID });
});

it.each([
  ["blank", { text: "  ", anchor: ANCHOR }],
  ["no anchor and no thread", { text: "x" }],
  ["both anchor and thread", { text: "x", anchor: ANCHOR, threadId: ID }],
  ["unknown key", { text: "x", anchor: ANCHOR, extra: 1 }],
  ["control character", { text: "a\u0000b", anchor: ANCHOR }],
  ["bidi override", { text: "a‮b", anchor: ANCHOR }],
  ["not normalized", { text: "e\u0301", anchor: ANCHOR }],
  ["thread id that is no id", { text: "x", threadId: "nije-id" }],
])("refuses a %s draft and never reaches the database", async (_name, body) => {
  expect((await send("POST", DRAFTS, body)).status).toBe(422);
  expect(query).not.toHaveBeenCalled();
});

it("publishes the drafts and answers how many, and 409 when there is none", async () => {
  query.mockResolvedValueOnce(rows({ published: 3 }));
  const response = await send("POST", "/works/izmisljeni-rad/comments/publish");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ published: 3 });
  query.mockRejectedValueOnce(Object.assign(new Error("x"), { code: "ZD409" }));
  expect((await send("POST", "/works/izmisljeni-rad/comments/publish")).status).toBe(409);
});

describe("publish-selected", () => {
  const PATH = "/works/izmisljeni-rad/comments/publish-selected";
  const ID2 = "7b6c5d4e-3f2a-4b1c-8d9e-0a1b2c3d4e02";
  const draft = (commentId: string) => ({
    threadId: ID,
    commentId,
    position: 1,
    text: "Izmišljena napomena.",
    anchor: ANCHOR,
    state: "open",
    createdWindow: AT,
  });

  // The first query takes the lock of the drafts (one void row), then the list, then the publish.
  it("publishes when the ids are exactly the caller's drafts", async () => {
    query.mockResolvedValueOnce(rows({}));
    query.mockResolvedValueOnce(rows(draft(ID), draft(ID2)));
    query.mockResolvedValueOnce(rows({ published: 2 }));
    const response = await send("POST", PATH, { draftIds: [ID2, ID] });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ published: 2 });
  });

  it.each([
    ["a draft was not seen", [ID]],
    ["an id comes twice", [ID, ID, ID2]],
  ])("answers 409 and publishes nothing when %s", async (_, draftIds) => {
    query.mockResolvedValueOnce(rows({}));
    query.mockResolvedValueOnce(rows(draft(ID), draft(ID2)));
    expect((await send("POST", PATH, { draftIds })).status).toBe(409);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["no ids", { draftIds: [] }],
    ["an id that is no id", { draftIds: ["nije-id"] }],
    ["no body key", {}],
    ["an unknown key", { draftIds: [ID], extra: 1 }],
  ])("refuses %s with 422 and never reaches the database", async (_, body) => {
    expect((await send("POST", PATH, body)).status).toBe(422);
    expect(query).not.toHaveBeenCalled();
  });

  it("refuses a missing body with 415", async () => {
    expect((await send("POST", PATH)).status).toBe(415);
    expect(query).not.toHaveBeenCalled();
  });
});

it("discards a draft with 204 and answers 404 for one that is not the caller's", async () => {
  query.mockResolvedValueOnce(rows({}));
  expect((await send("DELETE", `/comment-drafts/${ID}`)).status).toBe(204);
  query.mockRejectedValueOnce(Object.assign(new Error("x"), { code: "ZD403" }));
  expect((await send("DELETE", `/comment-drafts/${ID}`)).status).toBe(404);
  expect((await send("DELETE", "/comment-drafts/nije-id")).status).toBe(404);
});

it("serves the comment bank: list, save, delete; the text rules apply", async () => {
  query.mockResolvedValueOnce(
    rows(
      { templateId: ID, kind: "must", body: "Navedite izvor.", label: "Izvor", createdAt: AT },
      { templateId: ID2, kind: "q", body: "Zašto?", label: null, createdAt: AT },
    ),
  );
  const listed = await fetch(`${base()}/teacher/comment-bank`, { headers: cookie });
  expect(await listed.json()).toEqual({
    entries: [
      {
        id: ID,
        kind: "must",
        text: "Navedite izvor.",
        label: "Izvor",
        createdAt: AT.toISOString(),
      },
      { id: ID2, kind: "q", text: "Zašto?", label: null, createdAt: AT.toISOString() },
    ],
  });
  query.mockResolvedValueOnce(rows({ id: ID, createdAt: AT }));
  const saved = await send("POST", "/teacher/comment-bank", {
    text: "Navedite izvor.",
    kind: "must",
  });
  expect(saved.status).toBe(201);
  expect(await saved.json()).toEqual({ id: ID, createdAt: AT.toISOString() });
  expect((await send("POST", "/teacher/comment-bank", { text: "x", kind: "loud" })).status).toBe(
    422,
  );
  expect((await send("POST", "/teacher/comment-bank", { text: "   ", kind: "q" })).status).toBe(
    422,
  );
  query.mockResolvedValueOnce(rows({}));
  expect((await send("DELETE", `/teacher/comment-bank/${ID}`)).status).toBe(204);
  query.mockRejectedValueOnce(Object.assign(new Error("x"), { code: "ZD403" }));
  expect((await send("DELETE", `/teacher/comment-bank/${ID}`)).status).toBe(404);
});

it("saves a bank entry with its label, or none", async () => {
  query.mockResolvedValueOnce(rows({ id: ID, createdAt: AT }));
  expect(
    (await send("POST", "/teacher/comment-bank", { text: "Tekst.", kind: "q", label: "Oznaka" }))
      .status,
  ).toBe(201);
  expect(query.mock.calls.at(-1)![1]).toEqual(["Tekst.", "q", "Oznaka"]);
  query.mockResolvedValueOnce(rows({ id: ID, createdAt: AT }));
  await send("POST", "/teacher/comment-bank", { text: "Tekst.", kind: "q" });
  expect(query.mock.calls.at(-1)![1]).toEqual(["Tekst.", "q", null]);
  const before = query.mock.calls.length;
  for (const label of ["", "   ", "x".repeat(41), "a\u0000b", "e\u0301", "a\u202eb", 7]) {
    expect(
      (await send("POST", "/teacher/comment-bank", { text: "Tekst.", kind: "q", label })).status,
    ).toBe(422);
  }
  expect(query.mock.calls.length).toBe(before);
});

it("replaces a bank entry: the body goes to the database, the answer is 204, another's is 404", async () => {
  query.mockResolvedValueOnce(rows({}));
  const put = await send("PUT", `/teacher/comment-bank/${ID}`, {
    text: "Novi tekst.",
    kind: "sugg",
    label: "Nova",
  });
  expect(put.status).toBe(204);
  expect(query.mock.calls.at(-1)![1]).toEqual([ID, "Novi tekst.", "sugg", "Nova"]);
  query.mockResolvedValueOnce(rows({}));
  expect((await send("PUT", `/teacher/comment-bank/${ID}`, { text: "T.", kind: "q" })).status).toBe(
    204,
  );
  expect(query.mock.calls.at(-1)![1]).toEqual([ID, "T.", "q", null]);
  query.mockRejectedValueOnce(Object.assign(new Error("x"), { code: "ZD403" }));
  expect((await send("PUT", `/teacher/comment-bank/${ID}`, { text: "T.", kind: "q" })).status).toBe(
    404,
  );
  query.mockRejectedValueOnce(Object.assign(new Error("x"), { code: "XX000" }));
  expect((await send("PUT", `/teacher/comment-bank/${ID}`, { text: "T.", kind: "q" })).status).toBe(
    503,
  );
  const before = query.mock.calls.length;
  expect(
    (await send("PUT", "/teacher/comment-bank/nije-id", { text: "T.", kind: "q" })).status,
  ).toBe(404);
  expect((await send("PUT", `/teacher/comment-bank/${ID}`, { text: " ", kind: "q" })).status).toBe(
    422,
  );
  expect(
    (await send("PUT", `/teacher/comment-bank/${ID}`, { text: "T.", kind: "loud" })).status,
  ).toBe(422);
  expect(
    (await send("PUT", `/teacher/comment-bank/${ID}`, { text: "T.", kind: "q", label: "" })).status,
  ).toBe(422);
  expect(query.mock.calls.length).toBe(before);
});

it("marks a work reviewed with the revision the database gives, never one from the body", async () => {
  query.mockResolvedValueOnce(rows({ reviewedRevision: "4", reviewedAt: AT }));
  const response = await send("POST", "/works/izmisljeni-rad/review");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ reviewedRevision: 4, reviewedAt: AT.toISOString() });
  query.mockRejectedValueOnce(Object.assign(new Error("x"), { code: "ZD409" }));
  expect((await send("POST", "/works/izmisljeni-rad/review")).status).toBe(409);
});

it("answers the changes without asking for a comparison before a review or when nothing changed", async () => {
  const changes = () =>
    fetch(`${base()}/works/izmisljeni-rad/changes-since-review`, { headers: cookie });
  query.mockResolvedValueOnce(rows({ reviewedRevision: null, currentRevision: "4" }));
  expect(await (await changes()).json()).toEqual({
    reviewedRevision: null,
    currentRevision: 4,
    changed: false,
    blocks: [],
  });
  query.mockResolvedValueOnce(rows({ reviewedRevision: "4", currentRevision: "4" }));
  expect(await (await changes()).json()).toEqual({
    reviewedRevision: 4,
    currentRevision: 4,
    changed: false,
    blocks: [],
  });
  expect(compare).not.toHaveBeenCalled();
});

it("compares the reviewed revision with the current one and says whether anything changed", async () => {
  const changes = () =>
    fetch(`${base()}/works/izmisljeni-rad/changes-since-review`, { headers: cookie });
  const blocks = [
    { kind: "paragraph", text: "Stari.", change: "removed" },
    { kind: "paragraph", text: "Novi.", change: "added" },
  ];
  query.mockResolvedValueOnce(rows({ reviewedRevision: "2", currentRevision: "4" }));
  compare.mockResolvedValueOnce({ status: "ok", from: 2, to: 4, blocks });
  expect(await (await changes()).json()).toEqual({
    reviewedRevision: 2,
    currentRevision: 4,
    changed: true,
    blocks,
  });
  expect(compare).toHaveBeenCalledWith("izmisljeni-rad", 2, 4);
  query.mockResolvedValueOnce(rows({ reviewedRevision: "2", currentRevision: "4" }));
  compare.mockResolvedValueOnce({
    status: "ok",
    from: 2,
    to: 4,
    blocks: [{ kind: "paragraph", text: "Isti.", change: "unchanged" }],
  });
  expect(((await (await changes()).json()) as { changed: boolean }).changed).toBe(false);
});

it.each([
  [{ status: "not_found" }, 404],
  [{ status: "unauthenticated" }, 401],
  [{ status: "too_large" }, 503],
  [{ status: "unavailable", reason: "record_break" }, 503],
])("maps the comparison %j to %i", async (result, status) => {
  query.mockResolvedValueOnce(rows({ reviewedRevision: "2", currentRevision: "4" }));
  compare.mockResolvedValueOnce(result);
  const response = await fetch(`${base()}/works/izmisljeni-rad/changes-since-review`, {
    headers: cookie,
  });
  expect(response.status).toBe(status);
});

it("refuses a missing session and a wrong media type, and maps the database's refusals", async () => {
  expect((await fetch(`${base()}${DRAFTS}`)).status).toBe(401);
  expect((await fetch(`${base()}/teacher/comment-bank`)).status).toBe(401);
  expect(
    (
      await fetch(`${base()}/teacher/comment-bank/${ID}`, {
        method: "PUT",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify({ text: "T.", kind: "q" }),
      })
    ).status,
  ).toBe(401);
  expect((await send("POST", DRAFTS, "{}", { "content-type": "text/plain" })).status).toBe(415);
  expect((await send("POST", DRAFTS, "{")).status).toBe(400);
  expect(query).not.toHaveBeenCalled();
  query.mockRejectedValueOnce(Object.assign(new Error("x"), { code: "ZD403" }));
  expect((await fetch(`${base()}${DRAFTS}`, { headers: cookie })).status).toBe(404);
  query.mockRejectedValueOnce(new Error("boom"));
  expect((await fetch(`${base()}${DRAFTS}`, { headers: cookie })).status).toBe(503);
  query.mockRejectedValueOnce(new Error("boom"));
  expect(
    (await fetch(`${base()}/works/izmisljeni-rad/changes-since-review`, { headers: cookie }))
      .status,
  ).toBe(503);
});

// SRV-MENTOR-3: the HTTP edge of the note to self, the reading place, the
// seen marks and the mentor's overview over a scripted transaction. Who may
// is the database's (db/main/tests/233); this checks the edge: session,
// media type, body shape and the closed answers. Invented data only.
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { ActorTransaction, WithActor } from "../../database/index.ts";
import { createDatabases, createLayers, startServer, type Running } from "../index.ts";

import { createMentorshipFollowRoutesFor } from "./index.ts";

const ORIGIN = "https://ductura.example.invalid";
const TOKEN = "A".repeat(43);
const AT = new Date("2026-11-23T09:00:00.000Z");
const NODE = "1f0e2d3c-4b5a-4968-8776-655443322110";
const PLACE = { nodeId: NODE, offset: 12 };
const NOTE_ROW = {
  noteText: "Izmišljena bilješka.",
  notePlace: PLACE,
  noteUpdatedAt: AT,
  readingPlace: null,
  readingUpdatedAt: null,
};
const NOTE_STATE = {
  note: { text: "Izmišljena bilješka.", place: PLACE, updatedAt: AT.toISOString() },
  readingPlace: null,
};
const MSG = "7b6c5d4e-3f2a-4b1c-8d9e-0a1b2c3d4e02";

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
    routes: createMentorshipFollowRoutesFor({ withActor }),
  });
});
afterEach(() => server.close());

const base = () => `http://127.0.0.1:${server.port}/api/v1`;
const work = (tail: string, id = "izmisljeni-rad") => `${base()}/works/${id}/${tail}`;
const cookie = { cookie: `__Host-ductus_session=${TOKEN}` };
const send = (method: string, url: string, body?: string, headers: Record<string, string> = {}) =>
  fetch(url, {
    method,
    headers: {
      origin: ORIGIN,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...cookie,
      ...headers,
    },
    ...(body === undefined ? {} : { body }),
  });

it("reads nothing kept as two nulls, and the note as the database keeps it", async () => {
  query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
  const empty = await fetch(work("self-note"), { headers: cookie });
  expect(empty.status).toBe(200);
  expect(await empty.json()).toEqual({ note: null, readingPlace: null });
  query.mockResolvedValueOnce({ rows: [NOTE_ROW], rowCount: 1 });
  expect(await (await fetch(work("self-note"), { headers: cookie })).json()).toEqual(NOTE_STATE);
});

it("writes the note with and without a place", async () => {
  query.mockResolvedValue({ rows: [NOTE_ROW], rowCount: 1 });
  const written = await send(
    "PUT",
    work("self-note"),
    JSON.stringify({ text: "Izmišljena bilješka.", place: PLACE }),
  );
  expect(written.status).toBe(200);
  expect(await written.json()).toEqual(NOTE_STATE);
  expect(query.mock.calls[0]![1]).toEqual([
    "izmisljeni-rad",
    "Izmišljena bilješka.",
    JSON.stringify(PLACE),
  ]);
  await send("PUT", work("self-note"), JSON.stringify({ text: "Bez mjesta." }));
  expect(query.mock.calls[1]![1]).toEqual(["izmisljeni-rad", "Bez mjesta.", null]);
});

it.each([
  ["too long", { text: "a".repeat(281) }],
  ["blank", { text: "   " }],
  ["control character", { text: "a\u0000b" }],
  ["bidi override", { text: "a‮b" }],
  ["not normalized", { text: "é" }],
  ["quote in the place", { text: "x", place: { ...PLACE, quote: "y" } }],
  ["negative offset", { text: "x", place: { nodeId: NODE, offset: -1 } }],
  ["unknown key", { text: "x", extra: 1 }],
])("refuses a note that is %s and never reaches the database", async (_name, body) => {
  expect((await send("PUT", work("self-note"), JSON.stringify(body))).status).toBe(422);
  expect(query).not.toHaveBeenCalled();
});

it("writes and deletes the reading place, and deletes the note", async () => {
  query.mockResolvedValue({ rows: [], rowCount: 0 });
  expect((await send("PUT", work("reading-place"), JSON.stringify({ place: PLACE }))).status).toBe(
    200,
  );
  expect(query.mock.calls[0]![1]).toEqual(["izmisljeni-rad", JSON.stringify(PLACE)]);
  expect((await send("DELETE", work("reading-place"))).status).toBe(200);
  expect(query.mock.calls[1]![1]).toEqual(["izmisljeni-rad", "reading"]);
  expect((await send("DELETE", work("self-note"))).status).toBe(200);
  expect(query.mock.calls[2]![1]).toEqual(["izmisljeni-rad", "note"]);
  expect((await send("PUT", work("reading-place"), JSON.stringify({}))).status).toBe(422);
});

it("reports opened items and reads what the student has seen", async () => {
  const row = { itemKind: "message", itemId: MSG, firstSeenAt: AT };
  const mark = { kind: "message", id: MSG, firstSeenAt: AT.toISOString() };
  query.mockResolvedValue({ rows: [row], rowCount: 1 });
  const marked = await send(
    "POST",
    work("seen"),
    JSON.stringify({ items: [{ kind: "message", id: MSG }] }),
  );
  expect(marked.status).toBe(200);
  expect(await marked.json()).toEqual({ items: [mark] });
  expect(query.mock.calls[0]![1]).toEqual(["izmisljeni-rad", ["message"], [MSG]]);
  const seen = await fetch(work("seen-by-student"), { headers: cookie });
  expect(await seen.json()).toEqual({ items: [mark] });
  expect(query.mock.calls[1]![1]).toEqual(["izmisljeni-rad", 5000]);
  query.mockClear();
  for (const items of [
    [],
    [{ kind: "nesto", id: MSG }],
    Array(201).fill({ kind: "message", id: MSG }),
  ]) {
    expect((await send("POST", work("seen"), JSON.stringify({ items }))).status).toBe(422);
  }
  expect(query).not.toHaveBeenCalled();
});

it("answers the mentor's overview without a rank", async () => {
  query.mockResolvedValueOnce({
    rows: [
      {
        mentorshipId: "3e000000-0000-4000-8000-000000000001",
        assignmentId: "3e000000-0000-4000-8000-000000000011",
        documentId: null,
        givenName: "Ana",
        familyName: "Izmišljena",
        workType: "master_thesis",
        title: "Izmišljeni diplomski rad",
        stageMilestoneId: null,
        stageTitle: null,
        stagePosition: null,
        stageCount: 0,
        stageState: null,
        waitingOn: "student",
        nextDeadlineAt: null,
        daysToNextDeadline: null,
        newMessages: 0,
      },
    ],
    rowCount: 1,
  });
  const response = await fetch(`${base()}/teacher/mentorship-overview`, { headers: cookie });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    students: [
      {
        mentorshipId: "3e000000-0000-4000-8000-000000000001",
        assignmentId: "3e000000-0000-4000-8000-000000000011",
        documentId: null,
        givenName: "Ana",
        familyName: "Izmišljena",
        workType: "master_thesis",
        title: "Izmišljeni diplomski rad",
        stage: null,
        stageCount: 0,
        waitingOn: "student",
        nextDeadlineAt: null,
        daysToNextDeadline: null,
        newMessages: 0,
      },
    ],
  });
});

it("refuses a missing session, a wrong media type and broken JSON", async () => {
  expect((await fetch(work("self-note"))).status).toBe(401);
  expect((await fetch(`${base()}/teacher/mentorship-overview`)).status).toBe(401);
  expect(
    (await send("PUT", work("self-note"), "{}", { "content-type": "text/plain" })).status,
  ).toBe(415);
  expect((await send("PUT", work("self-note"), "{")).status).toBe(400);
  expect(query).not.toHaveBeenCalled();
});

it("answers 404 for a relation the database refuses, 503 for a fault and for a malformed row", async () => {
  query.mockRejectedValueOnce(Object.assign(new Error("x"), { code: "ZD403" }));
  expect((await fetch(work("self-note"), { headers: cookie })).status).toBe(404);
  query.mockRejectedValueOnce(new Error("boom"));
  expect((await fetch(work("self-note"), { headers: cookie })).status).toBe(503);
  query.mockResolvedValueOnce({
    rows: [{ ...NOTE_ROW, notePlace: { nodeId: NODE } }],
    rowCount: 1,
  });
  expect((await fetch(work("self-note"), { headers: cookie })).status).toBe(503);
  query.mockResolvedValueOnce({ rows: [NOTE_ROW, NOTE_ROW], rowCount: 2 });
  expect((await fetch(work("self-note"), { headers: cookie })).status).toBe(503);
});

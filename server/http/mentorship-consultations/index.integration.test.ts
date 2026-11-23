import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { ActorTransaction, WithActor } from "../../database/index.ts";
import { createDatabases, createLayers, startServer, type Running } from "../index.ts";

import { createMentorshipConsultationRoutesFor } from "./index.ts";

// SRV-MENTOR-1: the HTTP side over a stand-in database. Who may do what is
// decided by the database (pgTAP 232, matrix 030) and checked end to end in
// mentorship-consultations.pg.integration.test.ts.
const ORIGIN = "https://ductura.example.invalid";
const TOKEN = "t".repeat(43);
const SLOT = "00000000-0000-4000-8000-00000000a7a1";
const TASK = "00000000-0000-4000-8000-00000000a7c1";
const RECORD = "00000000-0000-4000-8000-00000000a7b1";
const AT = new Date("2026-12-04T12:00:00.000Z");
const query = vi.fn<(sql: string, values: readonly unknown[]) => unknown[]>();
const withActor: WithActor = (_token, run) =>
  run({
    query: async (sql: string, values?: readonly unknown[]) => {
      const rows = query(sql, values ?? []);
      return { rows, rowCount: rows.length };
    },
  } as ActorTransaction);
/** A database row: the camelCase keys of the test become the snake_case columns. */
const dbRow = (values: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key.replace(/[A-Z]/gu, (c) => `_${c.toLowerCase()}`),
      value,
    ]),
  );
const refusal = (code: string) =>
  Object.assign(new Error("refused"), { code }) as Error & { code: string };
const slotRow = (state: string, extra: Record<string, unknown> = {}) =>
  dbRow({
    id: SLOT,
    startsAt: AT,
    proposedAt: AT,
    state,
    topic: null,
    closedBy: null,
    closedReason: null,
    closedAt: null,
    preparationText: null,
    preparationChangedParagraphs: null,
    preparationResolvedComments: null,
    ...extra,
  });

let server: Running;
beforeAll(async () => {
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    databases: createDatabases(),
    layers: createLayers({ expectedOrigin: ORIGIN }),
    routes: createMentorshipConsultationRoutesFor({ withActor }),
  });
});
afterAll(async () => server.close());
beforeEach(() => query.mockReset());

function send(path: string, body?: unknown, token: string | null = TOKEN) {
  const headers = new Headers({ "sec-fetch-site": "same-origin" });
  if (token !== null) headers.set("cookie", `__Host-ductus_session=${token}`);
  if (body === undefined)
    return fetch(`http://127.0.0.1:${server.port}/api/v1/${path}`, { headers });
  headers.set("origin", ORIGIN);
  headers.set("content-type", "application/json");
  return fetch(`http://127.0.0.1:${server.port}/api/v1/${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("opening a mentorship", () => {
  it("passes the student in lowercase, the kind and the topic, and answers the mentorship", async () => {
    query.mockReturnValueOnce([{ id: "00000000-0000-4000-8000-00000000a701" }]);
    const response = await send("mentorships", {
      studentId: "00000000-0000-4000-8000-00000000A703",
      workType: "master_thesis",
      topic: "Izmišljena tema",
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ mentorshipId: "00000000-0000-4000-8000-00000000a701" });
    expect(query.mock.calls[0]?.[1]).toEqual([
      "00000000-0000-4000-8000-00000000a703",
      "master_thesis",
      "Izmišljena tema",
    ]);
  });

  it.each([
    ["ZD403", 404],
    ["ZD409", 409],
    ["ZD422", 422],
    ["ZD503", 503],
  ])("maps %s to %i", async (code, status) => {
    query.mockImplementationOnce(() => {
      throw refusal(code);
    });
    const response = await send("mentorships", {
      studentId: "00000000-0000-4000-8000-00000000a703",
      workType: "master_thesis",
    });
    expect(response.status).toBe(status);
  });

  it("refuses another kind of work before the database", async () => {
    const response = await send("mentorships", {
      studentId: "00000000-0000-4000-8000-00000000a703",
      workType: "essay",
    });
    expect(response.status).toBe(422);
    expect(query).not.toHaveBeenCalled();
  });
});

describe("consultation slots", () => {
  it("answers the requested slot with its topic and preparation", async () => {
    query.mockReturnValueOnce([{ id: SLOT }]).mockReturnValueOnce([
      slotRow("requested", {
        topic: "Metoda",
        preparationText: "Izmišljena priprema.",
        preparationChangedParagraphs: 3,
        preparationResolvedComments: 1,
      }),
    ]);
    const response = await send("works/doc-izmisljeni/consultation-slot-requests", {
      startsAt: "2026-12-04T13:00:00+01:00",
      topic: "Metoda",
      preparation: { text: "Izmišljena priprema.", changedParagraphs: 3, resolvedComments: 1 },
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      id: SLOT,
      startsAt: "2026-12-04T12:00:00.000Z",
      proposedAt: "2026-12-04T12:00:00.000Z",
      state: "requested",
      topic: "Metoda",
      closing: null,
      preparation: { text: "Izmišljena priprema.", changedParagraphs: 3, resolvedComments: 1 },
    });
    expect(query.mock.calls[0]?.[1]).toEqual([
      "doc-izmisljeni",
      "2026-12-04T13:00:00+01:00",
      "Metoda",
      "Izmišljena priprema.",
      3,
      1,
    ]);
  });

  it("refuses a preparation without its counts and a text over 4000 code points", async () => {
    for (const preparation of [
      { text: "Samo tekst." },
      { text: "x".repeat(4001), changedParagraphs: 0, resolvedComments: 0 },
    ]) {
      const response = await send("works/doc-izmisljeni/consultation-slot-requests", {
        startsAt: "2026-12-04T12:00:00Z",
        preparation,
      });
      expect(response.status).toBe(422);
    }
    expect(query).not.toHaveBeenCalled();
  });

  it("answers a closed slot with who closed it and why", async () => {
    query
      .mockReturnValueOnce([{ id: SLOT }])
      .mockReturnValueOnce([
        slotRow("declined", { closedBy: "teacher", closedReason: "Zauzeto.", closedAt: AT }),
      ]);
    const response = await send(`works/doc-izmisljeni/consultation-slots/${SLOT}/close`, {
      action: "decline",
      reason: "Zauzeto.",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      state: "declined",
      closing: { by: "teacher", reason: "Zauzeto.", at: "2026-12-04T12:00:00.000Z" },
    });
  });

  it.each([
    ["ZD403", 403],
    ["ZD409", 409],
    ["ZD422", 422],
  ])("maps %s on a closing to %i", async (code, status) => {
    query.mockImplementationOnce(() => {
      throw refusal(code);
    });
    const response = await send(`works/doc-izmisljeni/consultation-slots/${SLOT}/close`, {
      action: "withdraw",
    });
    expect(response.status).toBe(status);
  });

  it("reads a malformed work or slot id as 404 without the database", async () => {
    expect((await send("works/%20x/consultation-slot-details")).status).toBe(404);
    expect(
      (await send("works/doc-izmisljeni/consultation-slots/nije-id/close", { action: "cancel" }))
        .status,
    ).toBe(404);
    expect(query).not.toHaveBeenCalled();
  });

  it("is 401 without a session", async () => {
    expect(
      (await send("works/doc-izmisljeni/consultation-slot-details", undefined, null)).status,
    ).toBe(401);
  });
});

describe("agreed tasks", () => {
  const taskRow = (done: boolean) =>
    dbRow({
      id: TASK,
      recordId: RECORD,
      taskPosition: 1,
      body: "Izmišljeni zadatak.",
      done,
      markedAt: done ? new Date("2026-12-05T08:15:00.000Z") : null,
      createdAt: new Date("2026-12-04T12:00:00.000Z"),
    });

  it("answers the marked task as the list reads it", async () => {
    query.mockReturnValueOnce([{ id: TASK }]).mockReturnValueOnce([taskRow(true)]);
    const response = await send(`works/doc-izmisljeni/consultation-tasks/${TASK}/mark`, {
      done: true,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      id: TASK,
      recordId: RECORD,
      position: 1,
      text: "Izmišljeni zadatak.",
      done: true,
      markedAt: "2026-12-05T08:15:00.000Z",
      createdAt: "2026-12-04T12:00:00.000Z",
    });
  });

  it("reads a refusal of the database as 404, as the consultation records do", async () => {
    query.mockImplementationOnce(() => {
      throw refusal("ZD403");
    });
    const response = await send(`works/doc-izmisljeni/consultation-records/${RECORD}/tasks`, {
      text: "Studentov zadatak.",
    });
    expect(response.status).toBe(404);
  });

  it("is 503 for an answer outside the contract", async () => {
    query.mockReturnValueOnce([{ ...taskRow(false), ...dbRow({ taskPosition: 21 }) }]);
    expect((await send("works/doc-izmisljeni/consultation-tasks")).status).toBe(503);
  });
});

describe("notices of an opening", () => {
  it("is 422 for a cursor that is not an id and pages by 50", async () => {
    expect((await send("notifications/mentorship-opened?before=nije-id")).status).toBe(422);
    const rows = Array.from({ length: 51 }, (_, i) =>
      dbRow({
        id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
        mentorshipId: "00000000-0000-4000-8000-00000000a701",
        workType: "master_thesis",
        topic: null,
        givenName: null,
        familyName: null,
        createdAt: AT,
        readAt: null,
      }),
    );
    query.mockReturnValueOnce(rows);
    const response = await send("notifications/mentorship-opened");
    const body = (await response.json()) as { notifications: unknown[]; nextBefore: string };
    expect(body.notifications).toHaveLength(50);
    expect(body.nextBefore).toBe(rows[49]?.id);
  });
});

import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";

import type { ActorTransaction, WithActor } from "../../database/index.ts";

import { createDatabases, createLayers, startServer, type Running } from "../index.ts";
import { createPracticeJournalRoutesFor } from "./index.ts";

// The routes over a scripted database: shape checks, the refusals of the RPCs and
// the answers they become. Who may do what is the database's and is proved in
// tests/db/practice-journal.pg.integration.test.ts. Everything here is invented.
const ORIGIN = "https://ductura.example.invalid";
const TOKEN = "t".repeat(43);
const ID = "00000000-0000-4000-8000-0000000019a1";
const ENTRY = "00000000-0000-4000-8000-0000000019a2";
const BASE = `/api/v1/practice/placements/${ID.toUpperCase()}`;
const query = vi.fn<(sql: string, values?: readonly unknown[]) => unknown[]>();
const withActor: WithActor = (token, run) =>
  run({
    query: async (sql, values) => {
      expect(token).toBe(TOKEN);
      const rows = sql.includes("identity.touch_current_session") ? [] : query(sql, values);
      return { rows, rowCount: rows.length };
    },
  } as ActorTransaction);
const refuse = (code: string, message = "refused") => Object.assign(new Error(message), { code });

let running: Running;
beforeAll(async () => {
  running = await startServer({
    host: "127.0.0.1",
    port: 0,
    databases: createDatabases(),
    layers: createLayers({ expectedOrigin: ORIGIN }),
    routes: createPracticeJournalRoutesFor({ withActor }),
  });
});
afterAll(async () => running.close());
beforeEach(() => query.mockReset());

function call(path: string, input?: unknown, cookie = TOKEN, contentType = "application/json") {
  return fetch(`http://127.0.0.1:${running.port}${path}`, {
    headers: {
      ...(cookie ? { cookie: `__Host-ductus_session=${cookie}` } : {}),
      origin: ORIGIN,
      "sec-fetch-site": "same-origin",
      "content-type": contentType,
    },
    ...(input === undefined ? {} : { method: "POST", body: JSON.stringify(input) }),
  });
}
const ENTRY_INPUT = { date: "2026-11-02", hours: 7.5, text: "Izmišljeni zapis." };
const problem = async (response: Response) => ({
  status: response.status,
  code: ((await response.json()) as { code: string }).code,
});

it("answers a missing session with 401 and never reads the database", async () => {
  expect((await call(BASE + "/entries", undefined, "")).status).toBe(401);
  expect((await call(BASE + "/entries", ENTRY_INPUT, "")).status).toBe(401);
  expect(query).not.toHaveBeenCalled();
});

it("answers a malformed path id with the same 404 as another's practice, before the database", async () => {
  expect(await problem(await call("/api/v1/practice/placements/not-a-uuid/entries"))).toEqual({
    status: 404,
    code: "not_found",
  });
  query.mockImplementationOnce(() => {
    throw refuse("ZD404");
  });
  expect(await problem(await call(BASE + "/entries"))).toEqual({ status: 404, code: "not_found" });
  expect(query).toHaveBeenCalledTimes(1);
});

it("lists placements and reads entries with the signoffs as the contract says", async () => {
  query.mockReturnValueOnce([
    {
      placementId: ID,
      mentorshipId: ENTRY,
      organisationName: "Izmišljena organizacija",
      startsOn: "2026-10-01",
      endsOn: "2026-12-01",
      entryCount: 1,
      signedThrough: null,
    },
  ]);
  const listed = await call("/api/v1/practice/placements");
  expect(listed.status).toBe(200);
  expect(listed.headers.get("cache-control")).toBe("no-store");
  expect(((await listed.json()) as { placements: unknown[] }).placements).toHaveLength(1);

  query
    .mockReturnValueOnce([
      {
        entryId: ENTRY,
        date: "2026-11-02",
        hours: "7.5",
        text: "Zapis.",
        correctsEntryId: null,
        createdAt: new Date("2026-11-02T10:00:00.000Z"),
      },
    ])
    .mockReturnValueOnce([]);
  const read = await call(BASE + "/entries");
  expect(await read.json()).toEqual({
    entries: [
      {
        entryId: ENTRY,
        date: "2026-11-02",
        hours: 7.5,
        text: "Zapis.",
        correctsEntryId: null,
        createdAt: "2026-11-02T10:00:00.000Z",
      },
    ],
    signoffs: [],
  });
  expect(query.mock.calls[1]![1]).toEqual([ID]);
});

it("keeps entry input out of the database when it is not valid", async () => {
  for (const bad of [
    { ...ENTRY_INPUT, hours: 0.25 },
    { ...ENTRY_INPUT, hours: 13 },
    { ...ENTRY_INPUT, date: "2026-02-30" },
    { ...ENTRY_INPUT, text: "   " },
    { ...ENTRY_INPUT, text: "č" },
    { ...ENTRY_INPUT, text: "x‮y" },
    { ...ENTRY_INPUT, extra: 1 },
    { date: "2026-11-02", hours: 4 },
  ]) {
    expect((await call(BASE + "/entries", bad)).status, JSON.stringify(bad)).toBe(422);
  }
  expect((await call(BASE + "/entries", ENTRY_INPUT, TOKEN, "text/plain")).status).toBe(415);
  expect(query).not.toHaveBeenCalled();
});

it("tells the two refusals of one conflict apart and maps the rest", async () => {
  const cases: [string, string | undefined, number, string][] = [
    ["ZD409", "placement closed", 409, "placement_closed"],
    ["ZD409", "conflict", 409, "conflict"],
    ["ZD422", undefined, 422, "invalid_input"],
    ["ZD404", undefined, 404, "not_found"],
    ["ZD401", undefined, 401, "unauthorized"],
    ["XX000", undefined, 503, "unavailable"],
  ];
  for (const [code, message, status, answer] of cases) {
    query.mockImplementationOnce(() => {
      throw refuse(code, message);
    });
    expect(await problem(await call(BASE + "/entries", ENTRY_INPUT)), `${code} ${message}`).toEqual(
      {
        status,
        code: answer,
      },
    );
  }
  // The signoff has one 409: nothing to sign.
  query.mockImplementationOnce(() => {
    throw refuse("ZD409", "nothing to sign");
  });
  expect(await problem(await call(BASE + "/signoffs", { throughDate: "2026-11-02" }))).toEqual({
    status: 409,
    code: "nothing_to_sign",
  });
});

it("signs and opens through one RPC each and answers 201 with the contract's body", async () => {
  const SHA = "a".repeat(64);
  query.mockReturnValueOnce([{ signoffId: ID, entryCount: 2, entriesSha256: SHA }]);
  const signed = await call(BASE + "/signoffs", {
    throughDate: "2026-11-02",
    comment: "Izmišljeno.",
  });
  expect(signed.status).toBe(201);
  expect(await signed.json()).toEqual({ signoffId: ID, entryCount: 2, entriesSha256: SHA });
  expect(query.mock.calls[0]![1]).toEqual([ID, "2026-11-02", "Izmišljeno."]);

  query.mockReturnValueOnce([{ id: ID }]);
  const opened = await call("/api/v1/practice/placements", {
    mentorshipId: ENTRY.toUpperCase(),
    organisationName: "Izmišljena organizacija",
    startsOn: "2026-10-01",
    endsOn: "2026-12-01",
  });
  expect(opened.status).toBe(201);
  expect(await opened.json()).toEqual({ placementId: ID });
  expect(query.mock.calls[1]![1]![0]).toBe(ENTRY);

  // Backwards period and a date that does not exist never reach the RPC.
  for (const period of [
    { startsOn: "2026-12-02", endsOn: "2026-12-01" },
    { startsOn: "2026-02-30", endsOn: "2026-12-01" },
  ]) {
    const refused = await call("/api/v1/practice/placements", {
      mentorshipId: ENTRY,
      organisationName: "Org",
      ...period,
    });
    expect(refused.status).toBe(422);
  }
  expect(query).toHaveBeenCalledTimes(2);
});

it("does not show a signoff whose mentor has no name (503, not an invented name)", async () => {
  query.mockReturnValueOnce([
    {
      signoffId: ID,
      throughDate: "2026-11-02",
      entryCount: 1,
      entriesSha256: "b".repeat(64),
      comment: null,
      signedAt: new Date(),
      mentorId: ENTRY,
      mentorGivenName: null,
      mentorFamilyName: null,
    },
  ]);
  expect((await call(BASE + "/signoffs")).status).toBe(503);
});

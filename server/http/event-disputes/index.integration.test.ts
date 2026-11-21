// The event dispute routes over a fake withActor: the cookie, the work id, the
// checked body, the statements and every outcome as the contract's status and
// body. Every value is invented.
import { afterEach, expect, it } from "vitest";

import type { WithActor } from "../../database/index.ts";
import { createDatabases, createLayers, startServer, type Running } from "../index.ts";

import { createEventDisputeRoutesFor } from "./index.ts";

const TOKEN = "V".repeat(43);
const COOKIE = `__Host-ductus_session=${TOKEN}`;
const ORIGIN = "https://ductura.example.invalid";
const DOCUMENT = "izmisljeni-rad-0001";
const ID = "6a5b4c3d-2e1f-4a0b-9c8d-7e6f5a4b3c31";
const AT = new Date("2026-11-21T09:15:00.123Z");
const BODY = { kind: "dispute", eventId: "pastes/0", text: "Lijepljenje je iz mojih bilješki." };

let running: Running | undefined;
afterEach(async () => {
  await running?.close();
  running = undefined;
});

type Statement = { sql: string; values: readonly unknown[] | undefined };
type Answer = object[] | Error | ((sql: string) => object[] | Error);

async function serve(answer: Answer) {
  const statements: Statement[] = [];
  const withActor: WithActor = async (token, run) => {
    expect(token).toBe(TOKEN);
    return run({
      async query<Row>(sql: string, values?: readonly unknown[]) {
        statements.push({ sql, values });
        const given = typeof answer === "function" ? answer(sql) : answer;
        if (given instanceof Error) throw given;
        return { rows: given as Row[], rowCount: given.length };
      },
    });
  };
  running = await startServer({
    host: "127.0.0.1",
    port: 0,
    databases: createDatabases(),
    layers: createLayers({ expectedOrigin: ORIGIN }),
    routes: createEventDisputeRoutesFor({ withActor }),
  });
  return {
    url: `http://127.0.0.1:${running.port}/api/v1/works/${DOCUMENT}/event-disputes`,
    statements,
    base: `http://127.0.0.1:${running.port}/api/v1/works`,
  };
}

const coded = (code: string) => Object.assign(new Error("izmišljeno"), { code });
const row = (over: Record<string, unknown> = {}) => ({
  id: ID,
  kind: "dispute",
  eventId: "pastes/0",
  text: BODY.text,
  createdAt: AT,
  ...over,
});
const write = (url: string, body: unknown, cookie: string | null = COOKIE, extra = {}) =>
  fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: ORIGIN,
      "sec-fetch-site": "same-origin",
      ...(cookie === null ? {} : { cookie }),
      ...extra,
    },
    body: JSON.stringify(body),
  });

it("lists the records for whoever may read the work (200)", async () => {
  const { url, statements } = await serve([
    row(),
    row({ id: ID.replace("31", "32"), kind: "amendment" }),
  ]);
  const response = await fetch(url, { headers: { cookie: COOKIE } });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    disputes: [
      {
        disputeId: ID,
        kind: "dispute",
        eventId: "pastes/0",
        text: BODY.text,
        createdAt: "2026-11-21T09:15:00.123Z",
      },
      {
        disputeId: ID.replace("31", "32"),
        kind: "amendment",
        eventId: "pastes/0",
        text: BODY.text,
        createdAt: "2026-11-21T09:15:00.123Z",
      },
    ],
  });
  expect(statements[0]?.values).toEqual([DOCUMENT]);
});

it("answers 401 without a session and 404 for a bad or refused work", async () => {
  const { url, base } = await serve(coded("ZD403"));
  expect((await fetch(url)).status).toBe(401);
  expect((await fetch(`${base}/%20x/event-disputes`, { headers: { cookie: COOKIE } })).status).toBe(
    404,
  );
  expect((await fetch(url, { headers: { cookie: COOKIE } })).status).toBe(404);
});

it("adds a record: 201 with the id and the time, through the mutation layer", async () => {
  const { url, statements } = await serve([row()]);
  const response = await write(url, BODY);
  expect(response.status).toBe(201);
  expect(await response.json()).toEqual({ disputeId: ID, createdAt: "2026-11-21T09:15:00.123Z" });
  expect(statements).toHaveLength(1);
  expect(statements[0]?.sql).toContain("app.add_work_event_dispute");
  expect(statements[0]?.values).toEqual([DOCUMENT, "dispute", "pastes/0", BODY.text]);
});

it("the mutation layer refuses a missing origin and a cross-site write (403)", async () => {
  const { url, statements } = await serve([row()]);
  expect((await write(url, BODY, COOKIE, { origin: "https://drugo.example.invalid" })).status).toBe(
    403,
  );
  expect((await write(url, BODY, COOKIE, { "sec-fetch-site": "cross-site" })).status).toBe(403);
  expect(statements).toEqual([]);
});

it("refuses bad bodies with 422 and a wrong media type with 415, before the database", async () => {
  const { url, statements } = await serve([row()]);
  for (const body of [
    { ...BODY, kind: "note" },
    { ...BODY, eventId: "Pastes/0" },
    { ...BODY, text: "" },
    { ...BODY, text: "   " },
    { ...BODY, text: "a".repeat(1001) },
    { ...BODY, text: "a\u0007b" },
    { ...BODY, extra: 1 },
    { kind: "dispute", eventId: "pastes/0" },
  ]) {
    expect((await write(url, body)).status).toBe(422);
  }
  const plain = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "text/plain",
      origin: ORIGIN,
      "sec-fetch-site": "same-origin",
      cookie: COOKIE,
    },
    body: "x",
  });
  expect(plain.status).toBe(415);
  expect((await write(url, BODY, null)).status).toBe(401);
  expect(statements).toEqual([]);
});

it("a reader of the work who is not its owner gets 403, anyone else 404", async () => {
  const reader = await serve((sql) => (sql.includes("add_work") ? coded("ZD403") : [row()]));
  expect((await write(reader.url, BODY)).status).toBe(403);
  await running?.close();
  const stranger = await serve(coded("ZD403"));
  expect((await write(stranger.url, BODY)).status).toBe(404);
});

it("maps ZD422 to 422 and any other failure to 503", async () => {
  const a = await serve(coded("ZD422"));
  expect((await write(a.url, BODY)).status).toBe(422);
  await running?.close();
  const b = await serve(new Error("izmišljeno"));
  expect((await write(b.url, BODY)).status).toBe(503);
  expect((await fetch(b.url, { headers: { cookie: COOKIE } })).status).toBe(503);
});

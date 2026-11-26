import { afterEach, expect, it, vi } from "vitest";

import { encodeThesisOverviewCursor, type WithActor } from "../../database/index.ts";
import { createDatabases, createLayers, startServer, type Running } from "../index.ts";

import { createThesisOverviewRoutesFor } from "./index.ts";

// SRV-V16-POPIS-FAKULTET: the adapter over a scripted database. Every person and id is invented.
const TOKEN = "T".repeat(43);
const COOKIE = `__Host-ductus_session=${TOKEN}`;
const ORIGIN = "https://ductura.example.invalid";
const AT = new Date("2026-12-01T10:00:00.000Z");
const M1 = "00000000-0000-4000-8000-0000000000d1";
const M2 = "00000000-0000-4000-8000-0000000000d2";
const M3 = "00000000-0000-4000-8000-0000000000d3";

let running: Running | undefined;
afterEach(async () => {
  await running?.close();
  running = undefined;
});

type Answer = object[] | Error;
async function serve(...answers: Answer[]) {
  await running?.close();
  const query = vi.fn(async (_sql: string, _values?: readonly unknown[]) => {
    const answer = answers.shift() ?? [];
    if (answer instanceof Error) throw answer;
    return answer;
  });
  const withActor: WithActor = (token, run) => {
    expect(token).toBe(TOKEN);
    return run({
      async query<Row>(sql: string, values?: readonly unknown[]) {
        const rows = await query(sql, values);
        return { rows: rows as Row[], rowCount: rows.length };
      },
    });
  };
  running = await startServer({
    host: "127.0.0.1",
    port: 0,
    databases: createDatabases(),
    layers: createLayers({ expectedOrigin: ORIGIN }),
    routes: createThesisOverviewRoutesFor({ withActor }),
  });
  const base = `http://127.0.0.1:${running.port}/api/v1/institution/thesis-overview`;
  const get = (search = "", headers: Record<string, string> = { cookie: COOKIE }) =>
    fetch(base + search, { headers });
  return { get, query };
}

const sqlError = (code: string) => Object.assign(new Error("refused"), { code });
const row = (mentorshipId: string, extra: object = {}) => ({
  mentorshipId,
  documentId: "doc-izmisljeni-zavrsni-1",
  workType: "master_thesis",
  mentorGiven: "Marko",
  mentorFamily: "Izmišljenić",
  studentGiven: "Ana",
  studentFamily: null,
  stage: "none",
  defenseAt: null,
  topicState: "none",
  committeeSize: 0,
  ...extra,
});

it("reads a page: names (a half name is null), the date as ISO text, no next on the last page", async () => {
  const { get, query } = await serve([row(M1, { stage: "defense_scheduled", defenseAt: AT })]);
  const response = await get();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const body = (await response.json()) as { works: object[]; next: unknown };
  expect(body.next).toBeNull();
  expect(body.works).toEqual([
    {
      documentId: "doc-izmisljeni-zavrsni-1",
      workType: "master_thesis",
      mentorName: { givenName: "Marko", familyName: "Izmišljenić" },
      studentName: null,
      stage: "defense_scheduled",
      defenseAt: AT.toISOString(),
      topicState: "none",
      committeeSize: 0,
    },
  ]);
  // The first page: no stage, the default limit, no key.
  expect(query.mock.calls[0]?.[1]).toEqual([null, 50, false, null, null]);
});

it("gives next from the last kept row and drops the extra row", async () => {
  const { get, query } = await serve([row(M1, { defenseAt: AT }), row(M2)]);
  const body = (await (await get("?limit=1&stage=none")).json()) as {
    works: unknown[];
    next: string;
  };
  expect(body.works).toHaveLength(1);
  expect(body.next).toBe(encodeThesisOverviewCursor(AT, M1));
  expect(query.mock.calls[0]?.[1]).toEqual(["none", 1, false, null, null]);
});

it("passes the key of the cursor on to the next page", async () => {
  const { get, query } = await serve([row(M3)]);
  const response = await get(`?after=${encodeThesisOverviewCursor(null, M2)}`);
  expect(response.status).toBe(200);
  expect(query.mock.calls[0]?.[1]).toEqual([null, 50, true, null, M2]);
});

it("a cursor with a date reaches the RPC as that date", async () => {
  const { get, query } = await serve([]);
  await get(`?after=${encodeThesisOverviewCursor(AT, M1)}`);
  expect(query.mock.calls[0]?.[1]).toEqual([null, 50, true, AT, M1]);
});

it.each([
  ["an unknown stage", "?stage=graded"],
  ["an empty stage", "?stage="],
  ["a limit of 0", "?limit=0"],
  ["a limit of 201", "?limit=201"],
  ["a limit that is no number", "?limit=ten"],
  ["an unknown parameter", "?order=desc"],
  ["a repeated parameter", "?limit=5&limit=6"],
  ["a cursor nobody wrote", "?after=not-a-key"],
  ["a cursor with an id that is no uuid", `?after=${Buffer.from("-|x").toString("base64url")}`],
])("refuses %s with 422", async (_name, search) => {
  const { get, query } = await serve([row(M1)]);
  const response = await get(search);
  expect(response.status).toBe(422);
  expect(query.mock.calls.every((call) => !String(call[0]).includes("INSERT"))).toBe(true);
});

it.each([
  ["ZD401", 401, "unauthorized"],
  ["ZD403", 403, "forbidden"],
  ["ZD422", 422, "invalid_input"],
])("maps %s to %i", async (code, status, word) => {
  const { get } = await serve(sqlError(code));
  const response = await get();
  expect(response.status).toBe(status);
  expect(((await response.json()) as { error: string }).error).toBe(word);
});

it("a caller who is no administrator reads 403 even with a bad query", async () => {
  const { get } = await serve(sqlError("ZD403"));
  expect((await get("?stage=graded")).status).toBe(403);
});

it("an error outside the contract and an unknown fault are 503", async () => {
  expect((await (await serve(sqlError("ZD404"))).get()).status).toBe(503);
  expect((await (await serve(new Error("connection lost"))).get()).status).toBe(503);
});

it("needs a session", async () => {
  const { get, query } = await serve();
  expect((await get("", {})).status).toBe(401);
  expect(query).not.toHaveBeenCalled();
});

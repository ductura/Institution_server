import { afterEach, expect, it, vi } from "vitest";

import type { WithActor } from "../../database/index.ts";
import { createDatabases, createLayers, startServer, type Running } from "../index.ts";

import { createWorkSourceRoutesFor } from "./index.ts";

const ORIGIN = "https://ductura.example.invalid";
const TOKEN = "D".repeat(43);
const COOKIE = `__Host-ductus_session=${TOKEN}`;
const ASSIGNMENT = "00000000-0000-4000-8000-0000000000a1";
const SOURCE = "00000000-0000-4000-8000-00000000c0a1";
const INSTANT = new Date("2026-11-20T10:00:00.000Z");
const HEADERS = { cookie: COOKIE, origin: ORIGIN, "content-type": "application/json" };
const RECORD = {
  id: SOURCE,
  type: "book",
  authors: [{ kind: "person", family: "Izmišljeni", given: "Autor" }],
  year: 2019,
  title: "Izmišljena knjiga o kućnom kompostiranju",
  place: "Izmišljeni grad",
  publisher: "Izmišljena naklada",
};

let running: Running | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
});

type Query = (sql: string, values?: readonly unknown[]) => Promise<object[]>;

async function fixture(query: Query) {
  const spy = vi.fn(query);
  const withActor: WithActor = async (token, run) => {
    expect(token).toBe(TOKEN);
    return run({
      async query<Row>(sql: string, values?: readonly unknown[]) {
        const rows = await spy(sql, values);
        return { rows: rows as Row[], rowCount: rows.length };
      },
    });
  };
  running = await startServer({
    host: "127.0.0.1",
    port: 0,
    databases: createDatabases(),
    layers: createLayers({ expectedOrigin: ORIGIN }),
    routes: createWorkSourceRoutesFor({ withActor }),
  });
  const base = `http://127.0.0.1:${running.port}/api/v1/student/assignments/${ASSIGNMENT}/sources`;
  return { list: base, one: `${base}/${SOURCE}`, spy };
}

const row = (extra: object = {}) => ({
  id: SOURCE,
  record: RECORD,
  doi: null,
  isbn: null,
  undated: false,
  requirement: null,
  createdAt: INSTANT,
  updatedAt: INSTANT,
  ...extra,
});
const wire = (extra: object = {}) => ({
  ...row(extra),
  createdAt: INSTANT.toISOString(),
  updatedAt: INSTANT.toISOString(),
});
const put = (url: string, body: unknown, headers: Record<string, string> = HEADERS) =>
  fetch(url, { method: "PUT", headers, body: JSON.stringify(body) });
const refusal = (code: string) => Object.assign(new Error("refused"), { code });

it("reads assigned sources, adds and edits a student source, then removes it", async () => {
  const assigned = ["recommended", "required"].map((requirement, index) => {
    const id = "00000000-0000-4000-8000-00000000c0b" + index;
    return row({ id, record: { ...RECORD, id }, requirement });
  });
  let own: object[] = [];
  const { list, one, spy } = await fixture(async (sql, values) => {
    if (sql.includes("institution.work_sources(")) return [...assigned, ...own];
    if (sql.includes("institution.save_work_source(")) {
      own = [row({ record: JSON.parse(String(values?.[1])), doi: values?.[2], isbn: values?.[3] })];
      return own;
    }
    if (sql.includes("institution.delete_work_source(")) {
      own = [];
      return [{ removed: true }];
    }
    return [{ touched: true }];
  });
  const readList = () => fetch(list, { headers: { cookie: COOKIE } });
  const read = await readList();
  expect(read.status).toBe(200);
  expect(read.headers.get("cache-control")).toBe("no-store");
  expect(await read.json()).toEqual({ sources: assigned.map(wire) });
  expect(spy).toHaveBeenCalledWith(expect.stringContaining("institution.work_sources("), [
    ASSIGNMENT,
    null,
  ]);

  const saved = await put(one, { record: RECORD, doi: "10.1234/x", isbn: "9780000000002" });
  expect(saved.status).toBe(200);
  expect(await saved.json()).toEqual(wire({ doi: "10.1234/x", isbn: "9780000000002" }));
  const saveCall = spy.mock.calls.find(([sql]) => sql.includes("institution.save_work_source("));
  const [assignmentId, record, ...metadata] = saveCall?.[1] ?? [];
  expect(assignmentId).toBe(ASSIGNMENT);
  expect(JSON.parse(String(record))).toEqual(RECORD);
  expect(metadata).toEqual(["10.1234/x", "9780000000002", false]);

  const edited = { ...RECORD, title: "Dopunjena izmišljena knjiga" };
  expect((await put(one, { record: edited })).status).toBe(200);
  expect(await (await readList()).json()).toEqual({
    sources: [...assigned.map(wire), wire({ record: edited })],
  });

  const removed = await fetch(one, { method: "DELETE", headers: HEADERS });
  expect(removed.status).toBe(204);
  expect(await removed.text()).toBe("");
  expect(await (await readList()).json()).toEqual({ sources: assigned.map(wire) });
});

it("refuses a bad session, origin, body or record before any SQL", async () => {
  const { list, one, spy } = await fixture(async () => []);
  expect((await fetch(list)).status).toBe(401);
  expect(
    (await fetch(list.replace(ASSIGNMENT, "%zz"), { headers: { cookie: COOKIE } })).status,
  ).toBe(404);
  expect(
    (await put(one, { record: RECORD }, { ...HEADERS, origin: "https://x.invalid" })).status,
  ).toBe(403);
  expect(
    (
      await fetch(one, {
        method: "PUT",
        headers: { ...HEADERS, "content-type": "text/plain" },
        body: "{}",
      })
    ).status,
  ).toBe(415);
  expect((await fetch(one, { method: "PUT", headers: HEADERS, body: "{x" })).status).toBe(400);
  expect(
    (await fetch(one, { method: "PUT", headers: HEADERS, body: "a".repeat(65537) })).status,
  ).toBe(413);
  const web = { ...RECORD, type: "web" };
  for (const body of [
    { record: RECORD, extra: 1 },
    { record: RECORD, requirement: "required" },
    { record: { ...RECORD, id: "00000000-0000-4000-8000-00000000c0a9" } },
    { record: { ...RECORD, studentId: SOURCE } },
    { record: { ...RECORD, title: " leading space" } },
    { record: { ...RECORD, title: "Prvi\u202e drugi" } },
    { record: { ...RECORD, year: 999 } },
    { record: web },
    {
      record: {
        ...web,
        place: undefined,
        publisher: undefined,
        url: "https://izvor.invalid",
        accessed: "2026-02-29",
      },
    },
    { record: RECORD, doi: "NIJE-DOI" },
    { record: RECORD, isbn: "123" },
    { record: RECORD, isbn: "9780000000003" },
  ]) {
    const response = await put(one, body);
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: "invalid_input" });
  }
  expect((await fetch(one, { method: "DELETE" })).status).toBe(403);
  expect(spy).not.toHaveBeenCalled();
});

it("answers one 404 for every refusal of access, and 422 and 503 as the database says", async () => {
  let failure: unknown = refusal("ZD403");
  const { list, one } = await fixture(async () => {
    throw failure;
  });
  const calls = () => [
    fetch(list, { headers: { cookie: COOKIE } }),
    put(one, { record: RECORD }),
    fetch(one, { method: "DELETE", headers: HEADERS }),
  ];
  for (const response of await Promise.all(calls())) expect(response.status).toBe(404);
  failure = refusal("ZD401");
  for (const response of await Promise.all(calls())) expect(response.status).toBe(401);
  failure = refusal("ZD422");
  expect((await put(one, { record: RECORD })).status).toBe(422);
  failure = new Error("connection lost");
  for (const response of await Promise.all(calls())) expect(response.status).toBe(503);
});

it("answers 404 when a delete finds nothing, and 503 for a row that is not a source", async () => {
  let rows: object[] = [{ removed: false }];
  const { list, one } = await fixture(async () => rows);
  expect((await fetch(one, { method: "DELETE", headers: HEADERS })).status).toBe(404);
  rows = [row({ record: { ...RECORD, type: "film" } })];
  expect((await fetch(list, { headers: { cookie: COOKIE } })).status).toBe(503);
  rows = [row(), row()];
  expect((await put(one, { record: RECORD })).status).toBe(503);
  const otherId = "00000000-0000-4000-8000-00000000c0a9";
  rows = [row({ id: otherId, record: { ...RECORD, id: otherId } })];
  expect((await put(one, { record: RECORD })).status).toBe(503);
});

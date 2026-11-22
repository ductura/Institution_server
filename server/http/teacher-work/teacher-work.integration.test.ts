import { afterEach, expect, it, vi } from "vitest";

import type { WithActor } from "../../database/index.ts";
import { createDatabases, createLayers, startServer, type Running } from "../index.ts";

import { createTeacherWorkRoutesFor } from "./index.ts";

const ORIGIN = "https://ductura.example.invalid";
const TOKEN = "E".repeat(43);
const COOKIE = `__Host-ductus_session=${TOKEN}`;
const DOCUMENT = "izmisljeni-rad-0001";
const STUDENT = "aaaaaaaa-0000-4000-8000-000000000001";
const ASSIGNMENT = "bbbbbbbb-0000-4000-8000-000000000002";

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
    routes: createTeacherWorkRoutesFor({ withActor }),
  });
  const url = (id: string) => `http://127.0.0.1:${running!.port}/api/v1/teacher/works/${id}`;
  return { url, spy };
}

// Database column names are snake_case; keys are built from pairs so the rows read like the RPC's.
const row = (over: Record<string, unknown> = {}) =>
  Object.fromEntries([
    ["document_id", DOCUMENT],
    ["student_id", STUDENT],
    ["given_name", "Ivana"],
    ["family_name", "Izmišljena"],
    ["assignment_id", ASSIGNMENT],
    ["state", "predano"],
    ["prev_document_id", "izmisljeni-rad-0000"],
    ["next_document_id", null],
    ...Object.entries(over),
  ]);
const refusal = (code: string) => Object.assign(new Error("refused"), { code });
const get = (url: string, cookie = true) =>
  fetch(url, cookie ? { headers: { cookie: COOKIE } } : {});

it("reads the work with its neighbours and a joined name", async () => {
  const { url, spy } = await fixture(async () => [row()]);
  const response = await get(url(DOCUMENT));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    documentId: DOCUMENT,
    studentId: STUDENT,
    studentName: "Ivana Izmišljena",
    assignmentId: ASSIGNMENT,
    state: "predano",
    prevDocumentId: "izmisljeni-rad-0000",
    nextDocumentId: null,
  });
  expect(spy).toHaveBeenCalledWith(expect.stringContaining("app.teacher_work_get("), [DOCUMENT]);
});

it("gives a null name when the account has none", async () => {
  const { url } = await fixture(async () => [
    row(
      Object.fromEntries([
        ["given_name", null],
        ["family_name", null],
        ["state", "nakon_roka"],
      ]),
    ),
  ]);
  expect(await (await get(url(DOCUMENT))).json()).toMatchObject({
    studentName: null,
    state: "nakon_roka",
  });
});

it("answers 404 for no row and for a refused relation, and 401 without a session", async () => {
  const { url, spy } = await fixture(async () => []);
  expect((await get(url(DOCUMENT))).status).toBe(404);
  expect((await get(url(DOCUMENT), false)).status).toBe(401);
  const calls = spy.mock.calls.length;
  expect((await get(url(`${DOCUMENT}%00`))).status).toBe(404);
  expect(spy.mock.calls.length).toBe(calls);
});

it("maps ZD401, other errors and malformed rows", async () => {
  let mode: "ZD401" | "XX000" | "state" | "other-doc" = "ZD401";
  const { url } = await fixture(async () => {
    if (mode === "ZD401" || mode === "XX000") throw refusal(mode);
    return [
      mode === "state"
        ? row(Object.fromEntries([["state", "bogus"]]))
        : row(Object.fromEntries([["document_id", "drugi-rad"]])),
    ];
  });
  expect((await get(url(DOCUMENT))).status).toBe(401);
  mode = "XX000";
  expect((await get(url(DOCUMENT))).status).toBe(503);
  mode = "state";
  expect((await get(url(DOCUMENT))).status).toBe(503);
  mode = "other-doc";
  expect((await get(url(DOCUMENT))).status).toBe(503);
});

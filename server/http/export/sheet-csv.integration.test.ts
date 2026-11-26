// GET /api/v1/works/{documentId}/export/csv over a fake withActor: the cookie,
// the work id, the closed query, the one statement and its parameters, the CSV
// bytes (computed again from the stored formulas), the same bytes for the same
// version and every refusal as the contract's: another's work, a text work and
// an unknown sheet are the same 404. Every value is invented.
import { afterEach, expect, it, vi } from "vitest";

import { createWorkExportReader, type WithActor } from "../../database/index.ts";
import { createDatabases, createLayers, startServer, type Running } from "../index.ts";
import { createSheetCsvRoute } from "./sheet-csv.ts";

const TOKEN = "E".repeat(43);
const COOKIE = `__Host-ductus_session=${TOKEN}`;
const DOCUMENT = "00000000-0000-4000-8000-0000000000d1";
const SHEET_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SHEET_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SAVED = new Date("2026-11-27T22:41:00.000Z");
const SHEETS = JSON.stringify({
  schemaVersion: 1,
  kind: "spreadsheet",
  sheets: [
    {
      id: SHEET_A,
      name: "Prvi",
      rows: 10,
      columns: 3,
      cells: {
        ["A1"]: { value: "Stavka" },
        ["B1"]: { value: "Iznos" },
        ["A2"]: { value: "=zlo" },
        ["B2"]: { value: 2.5 },
        ["A3"]: { value: "Ukupno" },
        // The stored text carries no result; the server computes it again.
        ["B3"]: { value: null, formula: "=SUM(B2:B2)*2" },
      },
    },
    { id: SHEET_B, name: "Drugi", rows: 5, columns: 2, cells: { ["A1"]: { value: "drugi" } } },
  ],
});
const TEXT_WORK = JSON.stringify({
  schemaVersion: 4,
  sources: [],
  nodes: [
    {
      type: "paragraph",
      id: "00000000-0000-4000-8000-000000000002",
      children: [{ type: "text", text: "Izmišljeni odlomak.", marks: [] }],
    },
  ],
});
const found = (body: string, kind = "saved") => ({
  outcome: "found",
  revision: "3",
  kind,
  body,
  savedAt: SAVED,
});

let running: Running | undefined;
afterEach(async () => {
  await running?.close();
  running = undefined;
});

async function serve(answer: object[] | Error) {
  const spy = vi.fn(async (_sql: string, _values?: readonly unknown[]) => {
    if (answer instanceof Error) throw answer;
    return answer;
  });
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
    layers: createLayers({ expectedOrigin: "https://ductura.example.invalid" }),
    routes: [createSheetCsvRoute(createWorkExportReader(withActor))],
  });
  const url = (path = DOCUMENT, search = "") =>
    `http://127.0.0.1:${running!.port}/api/v1/works/${path}/export/csv${search}`;
  return { url, spy };
}

const get = (url: string, cookie: string | null = COOKIE) =>
  fetch(url, { headers: cookie === null ? {} : { cookie } });
const problem = async (response: Response) => [
  response.status,
  ((await response.json()) as { error?: unknown }).error,
];
const textOf = async (response: Response) =>
  new TextDecoder("utf-8", { ignoreBOM: true }).decode(await response.arrayBuffer());

it("answers the CSV of the first sheet, computed again, the same twice", async () => {
  const { url, spy } = await serve([found(SHEETS)]);
  const first = await get(url());
  expect(first.status).toBe(200);
  expect(first.headers.get("content-type")).toBe("text/csv; charset=utf-8");
  expect(first.headers.get("content-disposition")).toBe('attachment; filename="rad.csv"');
  expect(first.headers.get("cache-control")).toBe("private, no-store");
  const text = await textOf(first);
  expect(text).toBe("﻿Stavka;Iznos\r\n'=zlo;2.5\r\nUkupno;5\r\n");
  expect(await textOf(await get(url()))).toBe(text);
  // The newest saved version, through the same statement as the DOCX export.
  expect(spy.mock.calls[0]?.[1]).toEqual([DOCUMENT, null]);
});

it("answers the sheet named by id", async () => {
  const { url } = await serve([found(SHEETS)]);
  expect(await textOf(await get(url(DOCUMENT, `?sheet=${SHEET_B}`)))).toBe("﻿drugi\r\n");
});

it("refuses without a cookie, a bad query and a bad work id before the database", async () => {
  const { url, spy } = await serve([found(SHEETS)]);
  expect(await problem(await get(url(), null))).toEqual([401, "unauthorized"]);
  for (const search of [
    "?sheet=nije-id",
    "?sheet=",
    `?sheet=${SHEET_A.toUpperCase()}`,
    `?sheet=${SHEET_A}&sheet=${SHEET_B}`,
    `?sheet=${SHEET_A}&format=csv`,
    "?versionId=1",
  ]) {
    expect(await problem(await get(url(DOCUMENT, search)))).toEqual([422, "invalid_input"]);
  }
  expect(await problem(await get(url("%20doc")))).toEqual([404, "not_found"]);
  expect(spy).not.toHaveBeenCalled();
});

it("answers another's work, a text work, a broken body and an unknown sheet as the same 404", async () => {
  const cases: [object[], string][] = [
    [[{ outcome: "not_found" }], ""],
    [[found(TEXT_WORK)], ""],
    [[found("nije json")], ""],
    [[found(JSON.stringify({ schemaVersion: 1, kind: "spreadsheet", sheets: [] }))], ""],
    [[found(SHEETS)], "?sheet=cccccccc-cccc-4ccc-8ccc-cccccccccccc"],
  ];
  for (const [answer, search] of cases) {
    await running?.close();
    const { url } = await serve(answer);
    expect(await problem(await get(url(DOCUMENT, search)))).toEqual([404, "not_found"]);
  }
});

it("answers the database's failures as the contract's", async () => {
  const cases: [object[] | Error, [number, string]][] = [
    [Object.assign(new Error("izmišljeno"), { code: "ZD401" }), [401, "unauthorized"]],
    [new Error("izmišljeno"), [503, "unavailable"]],
    [[], [503, "unavailable"]],
  ];
  const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
  for (const [answer, expected] of cases) {
    await running?.close();
    const { url } = await serve(answer);
    expect(await problem(await get(url()))).toEqual(expected);
  }
  quiet.mockRestore();
});

it("exports a submitted version with the same bytes as a saved one", async () => {
  const bytes = async (kind: string) => {
    await running?.close();
    const { url } = await serve([found(SHEETS, kind)]);
    return textOf(await get(url()));
  };
  expect(await bytes("submitted")).toBe(await bytes("saved"));
});

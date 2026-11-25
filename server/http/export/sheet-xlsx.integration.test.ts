// GET /api/v1/works/{documentId}/export/xlsx over a fake withActor: the cookie, the
// work id, the closed query, the one statement and its parameters, the same bytes
// for the same version, a text work and another's work as the same 404, and every
// failure as the contract's. Every value is invented.
import { afterEach, expect, it, vi } from "vitest";

import { createWorkExportReader, type WithActor } from "../../database/index.ts";
import { createDatabases, createLayers, startServer, type Running } from "../index.ts";
import { createSheetXlsxRoute } from "./sheet-xlsx.ts";

const TOKEN = "E".repeat(43);
const COOKIE = `__Host-ductus_session=${TOKEN}`;
const DOCUMENT = "00000000-0000-4000-8000-0000000000d1";
const SAVED = new Date("2026-11-27T22:41:00.000Z");
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const SHEET = {
  schemaVersion: 1,
  kind: "spreadsheet",
  sheets: [
    {
      id: "00000000-0000-4000-8000-0000000000a1",
      name: "Demo",
      rows: 5,
      columns: 3,
      cells: {
        A1: { value: 2 },
        A2: { value: 3 },
        A3: { value: null, formula: "=SUM(A1:A2)" },
      },
    },
  ],
};
const FOUND = {
  outcome: "found",
  revision: "3",
  kind: "saved",
  body: JSON.stringify(SHEET),
  savedAt: SAVED,
};
const TEXT_WORK = JSON.stringify({ schemaVersion: 4, sources: [], nodes: [] });

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
    routes: [createSheetXlsxRoute(createWorkExportReader(withActor))],
  });
  const url = (path = DOCUMENT, search = "") =>
    `http://127.0.0.1:${running!.port}/api/v1/works/${path}/export/xlsx${search}`;
  return { url, spy };
}

const get = (url: string, cookie: string | null = COOKIE) =>
  fetch(url, { headers: cookie === null ? {} : { cookie } });
const problem = async (response: Response) => [
  response.status,
  ((await response.json()) as { error?: unknown }).error,
];

it("answers the .xlsx with the computed formula and the same bytes twice", async () => {
  const { url, spy } = await serve([FOUND]);
  const first = await get(url());
  expect(first.status).toBe(200);
  expect(first.headers.get("content-type")).toBe(XLSX);
  expect(first.headers.get("content-disposition")).toBe('attachment; filename="rad.xlsx"');
  expect(first.headers.get("x-export-sheet-sha256")).toMatch(/^[0-9a-f]{64}$/);
  const bytes = Buffer.from(await first.arrayBuffer());
  expect(bytes.subarray(0, 4).toString("hex")).toBe("504b0304");
  expect(bytes.toString("latin1")).toContain("<f>SUM(A1:A2)</f><v>5</v>");
  const second = await get(url());
  expect(Buffer.from(await second.arrayBuffer()).equals(bytes)).toBe(true);
  expect(spy.mock.calls[0]?.[1]).toEqual([DOCUMENT, null]);
});

it("passes versionId as the revision and refuses a row of another revision", async () => {
  const { url, spy } = await serve([FOUND]);
  expect((await get(url(DOCUMENT, "?versionId=3"))).status).toBe(200);
  expect(spy.mock.calls[0]?.[1]).toEqual([DOCUMENT, 3]);
  expect(await problem(await get(url(DOCUMENT, "?versionId=4")))).toEqual([503, "unavailable"]);
});

it("refuses without a cookie, a bad query and a bad work id before the database", async () => {
  const { url, spy } = await serve([FOUND]);
  expect(await problem(await get(url(), null))).toEqual([401, "unauthorized"]);
  for (const search of [
    "?format=xlsx",
    "?versionId=0",
    "?versionId=03",
    "?role=teacher",
    "?versionId=1&versionId=2",
  ]) {
    expect(await problem(await get(url(DOCUMENT, search)))).toEqual([422, "invalid_input"]);
  }
  expect(await problem(await get(url("%20doc")))).toEqual([404, "not_found"]);
  expect(spy).not.toHaveBeenCalled();
});

it("answers a text work and another's work as the same 404", async () => {
  const text = await serve([{ ...FOUND, body: TEXT_WORK }]);
  expect(await problem(await get(text.url()))).toEqual([404, "not_found"]);
  await running?.close();
  const other = await serve([{ outcome: "not_found" }]);
  expect(await problem(await get(other.url()))).toEqual([404, "not_found"]);
});

it("answers the database's failures and an unreadable spreadsheet as the contract's", async () => {
  const broken = JSON.stringify({ ...SHEET, sheets: [{ ...SHEET.sheets[0], rows: 1000 }] });
  const cases: [object[] | Error, [number, string]][] = [
    [Object.assign(new Error("izmišljeno"), { code: "ZD401" }), [401, "unauthorized"]],
    [new Error("izmišljeno"), [503, "unavailable"]],
    [[], [503, "unavailable"]],
    [[{ ...FOUND, body: "nije json" }], [503, "unavailable"]],
    [[{ ...FOUND, body: broken }], [503, "unavailable"]],
  ];
  const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
  for (const [answer, expected] of cases) {
    await running?.close();
    const { url } = await serve(answer);
    expect(await problem(await get(url()))).toEqual(expected);
  }
  quiet.mockRestore();
});

// GET /api/v1/works/{documentId}/export over a fake withActor: the cookie, the
// work id, the closed query (pdf is 422), the one statement and its
// parameters, the same bytes and fingerprint for the same version, and every
// refusal as the contract's. Every value is invented.
import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";

import { createWorkExportReader, type WithActor } from "../../database/index.ts";
import { createDatabases, createLayers, startServer, type Running } from "../index.ts";
import { createWorkExportRoute } from "./index.ts";

const TOKEN = "E".repeat(43);
const COOKIE = `__Host-ductus_session=${TOKEN}`;
const DOCUMENT = "00000000-0000-4000-8000-0000000000d1";
const SAVED = new Date("2026-11-27T22:41:00.000Z");
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const BODY = JSON.stringify({
  schemaVersion: 4,
  sources: [],
  nodes: [
    {
      type: "heading",
      id: "00000000-0000-4000-8000-000000000001",
      level: 1,
      children: [{ type: "text", text: "Izmišljeni rad", marks: [] }],
    },
    {
      type: "paragraph",
      id: "00000000-0000-4000-8000-000000000002",
      children: [{ type: "text", text: "Izmišljeni odlomak.", marks: [] }],
    },
  ],
});
const FOUND = { outcome: "found", revision: "3", kind: "saved", body: BODY, savedAt: SAVED };

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
    routes: [createWorkExportRoute(createWorkExportReader(withActor))],
  });
  const url = (path = DOCUMENT, search = "?format=docx") =>
    `http://127.0.0.1:${running!.port}/api/v1/works/${path}/export${search}`;
  return { url, spy };
}

const get = (url: string, cookie: string | null = COOKIE) =>
  fetch(url, { headers: cookie === null ? {} : { cookie } });
const problem = async (response: Response) => [
  response.status,
  ((await response.json()) as { error?: unknown }).error,
];

it("answers the DOCX with the fingerprint of the snapshot, the same twice", async () => {
  const { url, spy } = await serve([FOUND]);
  const first = await get(url());
  expect(first.status).toBe(200);
  expect(first.headers.get("content-type")).toBe(DOCX);
  const bytes = Buffer.from(await first.arrayBuffer());
  expect(bytes.subarray(0, 4).toString("hex")).toBe("504b0304");
  expect(first.headers.get("x-export-snapshot-sha256")).toMatch(/^[0-9a-f]{64}$/);
  const second = await get(url());
  expect(Buffer.from(await second.arrayBuffer()).equals(bytes)).toBe(true);
  expect(second.headers.get("x-export-snapshot-sha256")).toBe(
    first.headers.get("x-export-snapshot-sha256"),
  );
  expect(createHash("sha256").update(bytes).digest("hex")).toHaveLength(64);
  expect(spy.mock.calls[0]?.[1]).toEqual([DOCUMENT, null]);
});

it("passes versionId as the revision and refuses a row of another revision", async () => {
  const { url, spy } = await serve([FOUND]);
  expect((await get(url(DOCUMENT, "?format=docx&versionId=3"))).status).toBe(200);
  expect(spy.mock.calls[0]?.[1]).toEqual([DOCUMENT, 3]);
  expect(await problem(await get(url(DOCUMENT, "?format=docx&versionId=4")))).toEqual([
    503,
    "unavailable",
  ]);
});

it("refuses without a cookie, a bad query, pdf and a bad work id before the database", async () => {
  const { url, spy } = await serve([FOUND]);
  expect(await problem(await get(url(), null))).toEqual([401, "unauthorized"]);
  for (const search of [
    "",
    "?format=pdf",
    "?format=docx&versionId=0",
    "?format=docx&versionId=03",
    "?format=docx&role=teacher",
    "?format=docx&format=docx",
    "?format=docx&versionId=1&versionId=2",
  ]) {
    expect(await problem(await get(url(DOCUMENT, search)))).toEqual([422, "invalid_input"]);
  }
  expect(await problem(await get(url("%20doc")))).toEqual([404, "not_found"]);
  expect(spy).not.toHaveBeenCalled();
});

it("answers the database's refusals and failures as the contract's", async () => {
  const cases: [object[] | Error, [number, string]][] = [
    [[{ outcome: "not_found" }], [404, "not_found"]],
    [Object.assign(new Error("izmišljeno"), { code: "ZD401" }), [401, "unauthorized"]],
    [new Error("izmišljeno"), [503, "unavailable"]],
    [[], [503, "unavailable"]],
    [[{ ...FOUND, body: "nije json" }], [503, "unavailable"]],
    [
      [{ ...FOUND, body: JSON.stringify({ schemaVersion: 4, sources: [], nodes: "x" }) }],
      [503, "unavailable"],
    ],
  ];
  const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
  for (const [answer, expected] of cases) {
    await running?.close();
    const { url } = await serve(answer);
    expect(await problem(await get(url()))).toEqual(expected);
  }
  quiet.mockRestore();
});

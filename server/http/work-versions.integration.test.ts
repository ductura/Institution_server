// GET /api/v1/works/{documentId}/versions over a fake withActor: the cookie,
// the work id, the closed query, the one statement and its parameters, and
// every outcome as the contract's status and body. Every value is invented.
import { afterEach, expect, it, vi } from "vitest";

import type { WithActor } from "../database/index.ts";
import { createDatabases, createLayers, startServer, type Running } from "./index.ts";
import { createWorkVersionsRoute } from "./work-versions.ts";
import { createWorkVersionsReader } from "../database/index.ts";

const TOKEN = "V".repeat(43);
const COOKIE = `__Host-ductus_session=${TOKEN}`;
const DOCUMENT = "00000000-0000-4000-8000-0000000000d1";
const MINUTE = new Date("2026-11-27T22:41:00.000Z");

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
    routes: [createWorkVersionsRoute(createWorkVersionsReader(withActor))],
  });
  const url = (path = DOCUMENT, search = "") =>
    `http://127.0.0.1:${running!.port}/api/v1/works/${path}/versions${search}`;
  return { url, spy };
}

const get = (url: string, cookie: string | null = COOKIE) =>
  fetch(url, { headers: cookie === null ? {} : { cookie } });
const problem = async (response: Response) => [
  response.status,
  ((await response.json()) as { error?: unknown }).error,
];

it("answers one page, newest first, with the cursor of the next one", async () => {
  const { url, spy } = await serve([
    {
      outcome: "found",
      kind: "submission",
      revision: "42",
      savedMinute: MINUTE,
      afterDeadline: false,
    },
    {
      outcome: "found",
      kind: "checkpoint",
      revision: "42",
      savedMinute: MINUTE,
      afterDeadline: null,
    },
  ]);
  const response = await get(url(DOCUMENT, "?beforeRevision=43"));
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({
    versions: [
      { kind: "submission", revision: 42, savedMinute: MINUTE.toISOString(), afterDeadline: false },
      { kind: "checkpoint", revision: 42, savedMinute: MINUTE.toISOString() },
    ],
    nextBeforeRevision: null,
  });
  expect(spy).toHaveBeenCalledOnce();
  expect(spy.mock.calls[0]?.[1]).toEqual([DOCUMENT, 43]);
});

it("answers an empty list for a work with no version", async () => {
  const { url } = await serve([{ outcome: "empty" }]);
  expect(await (await get(url())).json()).toEqual({ versions: [], nextBeforeRevision: null });
});

it("refuses without a cookie, a bad query and a bad work id before the database", async () => {
  const { url, spy } = await serve([{ outcome: "empty" }]);
  expect(await problem(await get(url(), null))).toEqual([401, "unauthorized"]);
  for (const search of [
    "?beforeRevision=1",
    "?beforeRevision=02",
    "?role=teacher",
    "?beforeRevision=3&beforeRevision=4",
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
    [
      [
        {
          outcome: "found",
          kind: "draft",
          revision: "3",
          savedMinute: MINUTE,
          afterDeadline: null,
        },
      ],
      [503, "unavailable"],
    ],
    [Object.assign(new Error("izmišljeno"), { code: "42883" }), [503, "unavailable"]],
  ];
  const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
  for (const [answer, expected] of cases) {
    const { url } = await serve(answer);
    expect(await problem(await get(url()))).toEqual(expected);
    await running?.close();
    running = undefined;
  }
  expect(stderr.mock.calls.some(([line]) => String(line).includes("rows_malformed"))).toBe(true);
  stderr.mockRestore();
});

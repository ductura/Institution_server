import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";

import type { ActorTransaction, WithActor } from "../database/index.ts";

import { createDatabases, createLayers, startServer, type Running } from "./index.ts";
import { createQualitativeCodesRoutesFor } from "./qualitative-codes.ts";

// The routes over a scripted database: shape checks, the refusals of the RPCs and
// the answers they become. Who owns a code is the database's and is proved over
// real PostgreSQL in tests/db/qualitative-codes.pg.integration.test.ts.
const ORIGIN = "https://ductura.example.invalid";
const TOKEN = "t".repeat(43);
const ID = "00000000-0000-4000-8000-0000000018a1";
const BASE = "/api/v1/student/qual/codes";
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
const row = (id: string, name: string, order: number) => ({
  id,
  name,
  description: "",
  order,
  segmentCount: 7,
});

let running: Running;
beforeAll(async () => {
  running = await startServer({
    host: "127.0.0.1",
    port: 0,
    databases: createDatabases(),
    layers: createLayers({ expectedOrigin: ORIGIN }),
    routes: createQualitativeCodesRoutesFor({ withActor }),
  });
});
afterAll(async () => running.close());
beforeEach(() => query.mockReset());

function call(method: string, path: string, input?: unknown, cookie = TOKEN) {
  return fetch(`http://127.0.0.1:${running.port}${path}`, {
    method,
    headers: {
      ...(cookie ? { cookie: `__Host-ductus_session=${cookie}` } : {}),
      origin: ORIGIN,
      "sec-fetch-site": "same-origin",
      ...(input === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
  });
}
const problem = async (response: Response) => ({
  status: response.status,
  code: ((await response.json()) as { code: string }).code,
});

it("answers a missing session with 401 and never reads the database", async () => {
  for (const [method, path, input] of [
    ["GET", BASE, undefined],
    ["POST", BASE, { name: "Kod" }],
    ["PATCH", `${BASE}/${ID}`, { name: "Kod" }],
    ["DELETE", `${BASE}/${ID}`, undefined],
  ] as const) {
    expect((await call(method, path, input, "")).status).toBe(401);
  }
  expect(query).not.toHaveBeenCalled();
});

it("lists the codebook in its own order and without the count of passages", async () => {
  query.mockReturnValueOnce([
    row(ID, "Odnos", 1),
    row("00000000-0000-4000-8000-0000000018a2", "Rok", 2),
  ]);
  const response = await call("GET", BASE);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({
    codes: [
      { id: ID, name: "Odnos", description: "", order: 1 },
      { id: "00000000-0000-4000-8000-0000000018a2", name: "Rok", description: "", order: 2 },
    ],
  });
  expect(query.mock.calls[0]?.[0]).toContain("ORDER BY ord");
});

it("answers a malformed id with the same 404 as another's code, before the database", async () => {
  for (const method of ["PATCH", "DELETE"]) {
    expect(
      await problem(
        await call(method, `${BASE}/not-a-uuid`, method === "PATCH" ? { name: "Kod" } : undefined),
      ),
    ).toEqual({ status: 404, code: "not_found" });
  }
  expect(query).not.toHaveBeenCalled();
});

it.each([
  ["a blank name", { name: "  " }],
  ["a padded name", { name: " Kod" }],
  ["a two-line description", { name: "Kod", description: "a\nb" }],
  ["a name over 80 characters", { name: "x".repeat(81) }],
  ["an unknown field", { name: "Kod", extra: 1 }],
  ["no name", { description: "Opis" }],
])("refuses %s with 422 before the database", async (_what, input) => {
  expect(await problem(await call("POST", BASE, input))).toEqual({
    status: 422,
    code: "invalid_input",
  });
  expect(query).not.toHaveBeenCalled();
});

it("adds a code and answers it with its place; a name already there is a conflict", async () => {
  query.mockReturnValueOnce([{ id: ID }]).mockReturnValueOnce([row(ID, "Odnos", 1)]);
  const created = await call("POST", BASE, { name: "Odnos" });
  expect(created.status).toBe(201);
  expect(await created.json()).toEqual({ id: ID, name: "Odnos", description: "", order: 1 });
  query.mockImplementationOnce(() => {
    throw refuse("ZD409", "conflict");
  });
  expect(await problem(await call("POST", BASE, { name: "odnos" }))).toEqual({
    status: 409,
    code: "conflict",
  });
});

it("refuses a change that changes nothing and a place beyond the codebook, writing nothing", async () => {
  expect(await problem(await call("PATCH", `${BASE}/${ID}`, {}))).toEqual({
    status: 422,
    code: "invalid_input",
  });
  expect(query).not.toHaveBeenCalled();
  query.mockReturnValueOnce([row(ID, "Odnos", 1)]);
  expect(await problem(await call("PATCH", `${BASE}/${ID}`, { order: 2 }))).toEqual({
    status: 422,
    code: "invalid_input",
  });
  expect(query).toHaveBeenCalledTimes(1);
});

it("answers a code that is not in the caller's codebook with 404 and writes nothing", async () => {
  query.mockReturnValueOnce([row("00000000-0000-4000-8000-0000000018a2", "Tuđi?", 1)]);
  expect(await problem(await call("PATCH", `${BASE}/${ID}`, { name: "Novo" }))).toEqual({
    status: 404,
    code: "not_found",
  });
  expect(query).toHaveBeenCalledTimes(1);
});

it("renames, then moves, and answers the code as it now is", async () => {
  query
    .mockReturnValueOnce([
      row(ID, "Odnos", 1),
      row("00000000-0000-4000-8000-0000000018a2", "Rok", 2),
    ])
    .mockReturnValueOnce([])
    .mockReturnValueOnce([])
    .mockReturnValueOnce([
      row("00000000-0000-4000-8000-0000000018a2", "Rok", 1),
      row(ID, "Veza", 2),
    ]);
  const response = await call("PATCH", `${BASE}/${ID.toUpperCase()}`, { name: "Veza", order: 2 });
  expect(await response.json()).toEqual({ id: ID, name: "Veza", description: "", order: 2 });
  expect(query.mock.calls.map((c) => String(c[0]).match(/app\.\w+/u)?.[0])).toEqual([
    "app.qual_codes",
    "app.update_qual_code",
    "app.move_qual_code",
    "app.qual_codes",
  ]);
  expect(query.mock.calls[1]?.[1]).toEqual([ID, "Veza", ""]);
  expect(query.mock.calls[2]?.[1]).toEqual([ID, 2]);
});

it("deletes only with confirmation when the code has passages, and only the one query is allowed", async () => {
  query.mockImplementationOnce(() => {
    throw refuse("ZD409", "confirm_required");
  });
  expect(await problem(await call("DELETE", `${BASE}/${ID}`))).toEqual({
    status: 409,
    code: "conflict",
  });
  expect(query.mock.calls[0]?.[1]).toEqual([ID, false]);
  for (const suffix of ["?confirm=yes", "?confirm=false", "?confirm=true&confirm=true", "?x=1"]) {
    expect((await call("DELETE", `${BASE}/${ID}${suffix}`)).status).toBe(422);
  }
  expect(query).toHaveBeenCalledTimes(1);
  query.mockReturnValueOnce([{ removed: 3 }]);
  const removed = await call("DELETE", `${BASE}/${ID}?confirm=true`);
  expect([removed.status, await removed.text()]).toEqual([204, ""]);
  expect(query.mock.calls[1]?.[1]).toEqual([ID, true]);
});

it("answers an unknown failure with 503 and keeps its text out of the answer", async () => {
  query.mockImplementationOnce(() => {
    throw new Error("secret detail");
  });
  const response = await call("GET", BASE);
  expect(response.status).toBe(503);
  expect(JSON.stringify(await response.json())).not.toContain("secret");
});

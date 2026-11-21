import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { WithActor } from "../../database/index.ts";
import { createDatabases, createLayers, startServer, type Running } from "../index.ts";

import { createSourceNotebookRoutesFor } from "./index.ts";

const ORIGIN = "https://ductura.example.invalid";
const TOKEN = "D".repeat(43);
const HEADERS = {
  cookie: `__Host-ductus_session=${TOKEN}`,
  origin: ORIGIN,
  "content-type": "application/json",
};
const DOCUMENT = "doc-izmisljeni-kisni-vrt";
const SOURCE = "00000000-0000-4000-8000-00000000c0a1";
const NOTE = {
  id: "00000000-0000-4000-8000-00000000b001",
  quote: "Vrt upija kišu.",
  page: "12–14",
  note: "Usporediti vrste tla.",
};
const rpc = vi.fn<(args: readonly unknown[] | undefined) => unknown>();
let server: Running;
let url: string;

beforeEach(async () => {
  rpc.mockReset();
  const withActor: WithActor = async (token, run) => {
    expect(token).toBe(TOKEN);
    return run({
      async query<Row>(sql: string, args?: readonly unknown[]) {
        if (!sql.includes("institution.source_notes(")) return { rows: [], rowCount: 0 };
        return { rows: [{ result: rpc(args) } as Row], rowCount: 1 };
      },
    });
  };
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    databases: createDatabases(),
    layers: createLayers({ expectedOrigin: ORIGIN }),
    routes: createSourceNotebookRoutesFor({ withActor }),
  });
  url = `http://127.0.0.1:${server.port}/api/v1/works/${DOCUMENT}/sources/${SOURCE}/notes`;
});

afterEach(async () => await server.close());

it("serves all four contract operations from the session-bound RPC without caching", async () => {
  const { id, ...fields } = NOTE;
  rpc
    .mockReturnValueOnce([NOTE])
    .mockReturnValueOnce(NOTE)
    .mockReturnValueOnce(NOTE)
    .mockReturnValueOnce(null);
  const read = await fetch(url, { headers: HEADERS });
  expect(read.status).toBe(200);
  expect(read.headers.get("cache-control")).toBe("no-store");
  expect(await read.json()).toEqual({ notes: [NOTE] });

  const created = await fetch(url, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify(fields),
  });
  expect(created.status).toBe(201);
  expect(await created.json()).toEqual(NOTE);

  const patch = await fetch(url, {
    method: "PATCH",
    headers: HEADERS,
    body: JSON.stringify({ noteId: id, page: NOTE.page }),
  });
  expect(patch.status).toBe(200);
  expect(await patch.json()).toEqual(NOTE);

  const deleted = await fetch(`${url}?noteId=${id}`, { method: "DELETE", headers: HEADERS });
  expect(deleted.status).toBe(204);
  expect(await deleted.text()).toBe("");
  expect(rpc.mock.calls).toEqual([
    [[DOCUMENT, SOURCE, "GET", null, null]],
    [[DOCUMENT, SOURCE, "POST", null, JSON.stringify(fields)]],
    [[DOCUMENT, SOURCE, "PATCH", id, JSON.stringify({ page: NOTE.page })]],
    [[DOCUMENT, SOURCE, "DELETE", id, null]],
  ]);
});

it.each([
  {},
  { note: null },
  { note: " " },
  { note: 4 },
  { note: "x\u0000y" },
  { note: "\ud800" },
  { page: "x".repeat(81) },
  { quote: "🌧".repeat(4001) },
  { note: "tekst", studentId: NOTE.id },
])("refuses an invalid note body before the database", async (body) => {
  const answer = await fetch(url, { method: "POST", headers: HEADERS, body: JSON.stringify(body) });
  expect(answer.status).toBe(422);
  expect(rpc).not.toHaveBeenCalled();
});

it("refuses missing sessions, malformed source IDs and ambiguous note IDs", async () => {
  expect((await fetch(url)).status).toBe(401);
  expect((await fetch(url.replace(SOURCE, "pogresan"), { headers: HEADERS })).status).toBe(404);
  const query = `?noteId=${NOTE.id}&noteId=${NOTE.id}`;
  expect((await fetch(url + query, { method: "DELETE", headers: HEADERS })).status).toBe(422);
  expect(rpc).not.toHaveBeenCalled();
});

it("maps database access refusal to the same 404 as an unknown source", async () => {
  rpc.mockImplementation(() => {
    throw Object.assign(new Error("private"), { code: "ZD403" });
  });
  const answer = await fetch(url, { headers: HEADERS });
  expect(answer.status).toBe(404);
  expect(await answer.json()).toMatchObject({ code: "not_found" });
});

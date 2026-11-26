// GET /api/v1/works/{documentId}/imports (work.imports.get, SRV-F4-PM2-R14-SRV)
// on a real server over a scripted transaction: the metadata of the imports,
// the closed refusals and that nothing but the work reaches the database. Who
// may read is decided by collaboration.list_imports (db/main/tests/
// 262-list-imports.sql). All values are invented.
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { ActorTransaction, WithActor } from "../../database/index.ts";
import { createDatabases, createLayers, startServer, type Running } from "../index.ts";

import { createImportRoutesFor } from "./index.ts";

const ORIGIN = "https://ductura.example.invalid";
const TOKEN = "A".repeat(43);
const AT = new Date("2026-11-21T09:00:00.000Z");
const IMPORT_ID = "0b5c2a7e-3f1d-4c8e-9a6b-1d2e3f4a5b6c";
const EVENT_ID = "1b2c3d4e-5f60-4718-8293-a4b5c6d7e8f9";

const query = vi.fn<ActorTransaction["query"]>();
const withActor: WithActor = (_token, run) => run({ query: query as ActorTransaction["query"] });
let server: Running;

beforeEach(async () => {
  query.mockReset();
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    layers: createLayers({ expectedOrigin: ORIGIN }),
    databases: createDatabases(),
    routes: createImportRoutesFor({ withActor }),
  });
});
afterEach(() => server.close());

const url = (id = "izmisljeni-rad") => `http://127.0.0.1:${server.port}/api/v1/works/${id}/imports`;
const get = (
  id?: string,
  headers: Record<string, string> = { cookie: `__Host-ductus_session=${TOKEN}` },
) => fetch(url(id), { headers });
const rows = (list: Record<string, unknown>[]) => ({ rows: list, rowCount: list.length });
const confirmed = {
  importId: IMPORT_ID,
  importKind: "file-upload",
  fileFormat: "docx",
  rawByteLength: 2048,
  fileName: "Izmisljeni seminar.docx",
  baseRevision: "4",
  preparedAt: AT,
  state: "confirmed",
  confirmedAt: new Date(AT.getTime() + 60_000),
  eventId: EVENT_ID,
};

it("lists the metadata of the imports and nothing else", async () => {
  query.mockResolvedValueOnce(rows([confirmed]));
  const response = await get();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    imports: [
      {
        importId: IMPORT_ID,
        importKind: "file-upload",
        fileFormat: "docx",
        rawByteLength: 2048,
        fileName: "Izmisljeni seminar.docx",
        baseRevision: 4,
        preparedAt: AT.toISOString(),
        state: "confirmed",
        confirmedAt: new Date(AT.getTime() + 60_000).toISOString(),
        eventId: EVENT_ID,
      },
    ],
  });
  expect(query).toHaveBeenCalledTimes(1);
  expect(query.mock.calls[0]![1]).toEqual(["izmisljeni-rad"]);
});

it("answers an empty list while nothing was imported", async () => {
  query.mockResolvedValueOnce(rows([]));
  const response = await get();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ imports: [] });
});

it("is 401 without a session and reads nothing", async () => {
  const response = await get("izmisljeni-rad", {});
  expect(response.status).toBe(401);
  expect(query).not.toHaveBeenCalled();
});

it("is the same 404 for a malformed work id, before the database", async () => {
  const response = await get("%20rad");
  expect(response.status).toBe(404);
  expect(query).not.toHaveBeenCalled();
});

it("is 404 for another's work (ZD403), without the database message", async () => {
  query.mockRejectedValueOnce(
    Object.assign(new Error("izmišljena poruka baze"), { code: "ZD403" }),
  );
  const response = await get();
  expect(response.status).toBe(404);
  expect(await response.text()).not.toContain("izmišljena");
});

it("is 503 for a database failure and for a row of another shape", async () => {
  query.mockRejectedValueOnce(Object.assign(new Error("x"), { code: "57014" }));
  expect((await get()).status).toBe(503);
  query.mockResolvedValueOnce(rows([{ ...confirmed, state: "cancelled" }]));
  expect((await get()).status).toBe(503);
});

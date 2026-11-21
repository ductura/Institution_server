import { Value } from "@sinclair/typebox/value";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";

import { RetentionReport } from "../../contracts/index.ts";
import type { ActorTransaction, WithActor } from "../../database/index.ts";

import { createDatabases, createLayers, startServer, type Running } from "../index.ts";
import { createRetentionRouteFor } from "./index.ts";

// SRV-1304: GET /api/v1/institution/retention over the real HTTP stack, with
// the database answer stubbed. Who is an administrator is the database's
// (pgTAP 182); here ZD401 and ZD403 must become 401 and 403.
const PATH = "/api/v1/institution/retention";
const TOKEN = "R".repeat(43);
const COOKIE = `__Host-ductus_session=${TOKEN}`;
const query = vi.fn();
const withActor: WithActor = (token, run) =>
  run({ query: query.bind(null, token) } as ActorTransaction);
let server: Running;

beforeAll(async () => {
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    layers: createLayers({ expectedOrigin: "https://ductura.example.invalid" }),
    databases: createDatabases(),
    routes: [createRetentionRouteFor({ withActor })],
  });
});
afterAll(async () => server.close());
beforeEach(() => {
  query.mockReset();
});

function get(path = PATH, headers: Record<string, string> = { cookie: COOKIE }) {
  return fetch(`http://127.0.0.1:${server.port}${path}`, { headers });
}

const ROWS = [
  { key: "sessions", candidates: 2 },
  { key: "live-state", candidates: 1 },
  { key: "versions", candidates: 3 },
  { key: "change-times", candidates: null },
  { key: "access-log", candidates: 3 },
];
const dbError = (code: string) => Object.assign(new Error(code), { code });

it("answers every class for the administrator, null periods always as a dry run", async () => {
  query.mockResolvedValue({ rows: ROWS });
  const response = await get();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const body = (await response.json()) as RetentionReport;
  expect(Value.Check(RetentionReport, body)).toBe(true);
  expect(body.classes.map((c) => [c.key, c.retentionDays, c.mode, c.candidates])).toEqual([
    ["sessions", 30, "execute", 2],
    ["live-state", null, "dry-run", 1],
    ["versions", null, "dry-run", 3],
    ["change-times", null, "dry-run", null],
    ["access-log", null, "dry-run", 3],
    ["receipts", null, "dry-run", null],
  ]);
  expect(body.classes.every((c) => c.lastRunAt === null)).toBe(true);
  // One read, for the institution of the session, through the session's token.
  expect(query).toHaveBeenCalledTimes(1);
  expect(query.mock.calls[0]![0]).toBe(TOKEN);
  // No institution from the request: the database takes it from the session.
  expect(String(query.mock.calls[0]![1])).toContain("app.retention_candidates()");
});

it("never counts receipts, even when the database sends a count", async () => {
  query.mockResolvedValue({ rows: [...ROWS, { key: "receipts", candidates: 9 }] });
  const body = (await (await get()).json()) as RetentionReport;
  expect(body.classes.find((c) => c.key === "receipts")!.candidates).toBeNull();
});

it("is 403 for a teacher, a student and another institution (ZD403)", async () => {
  query.mockRejectedValue(dbError("ZD403"));
  const response = await get();
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ code: "forbidden" });
});

it("is 401 without a cookie and for a session the database does not know", async () => {
  const none = await get(PATH, {});
  expect(none.status).toBe(401);
  expect(await none.json()).toMatchObject({ code: "unauthorized" });
  expect(query).not.toHaveBeenCalled();
  query.mockRejectedValue(dbError("ZD401"));
  const stale = await get();
  expect(stale.status).toBe(401);
  expect(await stale.json()).toMatchObject({ code: "unauthorized" });
});

it("refuses a query (422) and a cross-site read (403) before the database", async () => {
  expect((await get(`${PATH}?institution=demo`)).status).toBe(422);
  const cross = await get(PATH, { cookie: COOKIE, "sec-fetch-site": "cross-site" });
  expect(cross.status).toBe(403);
  expect(query).not.toHaveBeenCalled();
});

it("is 503 when the database fails or sends a class the catalogue does not know", async () => {
  query.mockRejectedValue(new Error("connection lost"));
  expect((await get()).status).toBe(503);
  query.mockReset();
  query.mockResolvedValue({ rows: [{ key: "grades", candidates: 1 }] });
  expect((await get()).status).toBe(503);
  query.mockReset();
  query.mockResolvedValue({ rows: [{ key: "sessions", candidates: "2" }] });
  expect((await get()).status).toBe(503);
});

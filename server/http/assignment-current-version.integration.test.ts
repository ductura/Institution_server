import { readFileSync } from "node:fs";

import { afterAll, beforeAll, expect, it, vi } from "vitest";

import type { WithActor } from "../database/index.ts";
import { SESSION_COOKIE_NAME } from "../session/index.ts";

import {
  createAssignmentCurrentVersionRouteFor,
  createDatabases,
  createLayers,
  startServer,
} from "./index.ts";

const { vectors } = JSON.parse(
  readFileSync(
    new URL("../contracts/vectors/institution.assignment.get.json", import.meta.url),
    "utf8",
  ),
) as {
  vectors: {
    name: string;
    response: {
      body: { assignmentId: string; opensAt: string; dueAt: string; [field: string]: unknown };
    };
  }[];
};
const BODY = vectors.find(({ name }) => name === "current")!.response.body;
const ID = BODY.assignmentId;
const ROW = { ...BODY, opensAt: new Date(BODY.opensAt), dueAt: new Date(BODY.dueAt) };
const TOKEN = "A".repeat(43);
const query = vi.fn();
const withActor: WithActor = (token, run) => {
  expect(token).toBe(TOKEN);
  return run({ query });
};
let server: Awaited<ReturnType<typeof startServer>>;

beforeAll(async () => {
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    layers: createLayers({ expectedOrigin: "https://ductura.example.invalid" }),
    databases: createDatabases(),
    routes: [createAssignmentCurrentVersionRouteFor({ withActor })],
  });
});
afterAll(async () => server?.close());

function get(id: string, headers: Record<string, string> = {}) {
  return fetch(`http://127.0.0.1:${server.port}/api/v1/institution/assignments/${id}`, {
    headers: { cookie: `${SESSION_COOKIE_NAME}=${TOKEN}`, ...headers },
  });
}

it("returns exactly the published response for the current assignment", async () => {
  query.mockResolvedValueOnce({ rows: [ROW], rowCount: 1 });
  const response = await get(ID.toUpperCase(), { "sec-fetch-site": "same-origin" });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual(BODY);
  expect(query).toHaveBeenCalledExactlyOnceWith(expect.any(String), [ID]);
});

it.each<{ id: string; headers: Record<string, string>; status: number; code: string }>([
  { id: ID, headers: { cookie: "" }, status: 401, code: "unauthorized" },
  { id: ID, headers: { "sec-fetch-site": "cross-site" }, status: 403, code: "forbidden" },
  { id: ID, headers: { "sec-fetch-site": "same-site" }, status: 403, code: "forbidden" },
  { id: "%zz", headers: {}, status: 422, code: "invalid_input" },
  { id: "nije-uuid", headers: {}, status: 422, code: "invalid_input" },
])("answers $status for $id without querying", async ({ id, headers, status, code }) => {
  const calls = query.mock.calls.length;
  const response = await get(id, headers);
  expect(response.status).toBe(status);
  expect(await response.json()).toMatchObject({ code });
  expect(query).toHaveBeenCalledTimes(calls);
});

it.each([
  { rows: [], status: 401, code: "unauthorized" },
  { rows: [{ assignmentId: null }], status: 404, code: "not_found" },
  { rows: [ROW, ROW], status: 503, code: "unavailable" },
  { rows: [{ ...ROW, assignmentId: "other" }], status: 503, code: "unavailable" },
  { rows: [{ ...ROW, opensAt: null, dueAt: null }], status: 503, code: "unavailable" },
  { rows: [{ ...ROW, dueAt: new Date(NaN) }], status: 503, code: "unavailable" },
  { rows: [{ ...ROW, versionNo: 0 }], status: 503, code: "unavailable" },
  { rows: [{ ...ROW, internal: "unexpected" }], status: 503, code: "unavailable" },
])("answers $status for the reader outcome", async ({ rows, status, code }) => {
  query.mockResolvedValueOnce({ rows, rowCount: rows.length });
  const response = await get(ID);
  expect(response.status).toBe(status);
  expect(await response.json()).toMatchObject({ code });
});

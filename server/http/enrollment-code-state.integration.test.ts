// institution.enrollment-code-state.get over a fake withActor: the published
// vectors, the refusals before the reader and the reader's outcomes. The
// database side (RLS, the teacher relation) is the PostgreSQL test of
// server/institution/enrollment-code-state. Every value is invented.
import { readFileSync } from "node:fs";

import { afterAll, beforeAll, expect, it, vi } from "vitest";

import type { WithActor } from "../database/index.ts";
import { SESSION_COOKIE_NAME } from "../session/index.ts";

import {
  createDatabases,
  createEnrollmentCodeStateRouteFor,
  createLayers,
  startServer,
} from "./index.ts";

type Vector = {
  name: string;
  request: { params: { courseId: string } };
  response: { status: number; body: Record<string, unknown> };
};
const { vectors } = JSON.parse(
  readFileSync(
    new URL("../contracts/vectors/institution.enrollment-code-state.get.json", import.meta.url),
    "utf8",
  ),
) as { vectors: Vector[] };
const vector = (name: string) => vectors.find((found) => found.name === name)!;
const ISSUED = vector("issued").response.body as { current: { validUntil: string } };
const ID = vector("issued").request.params.courseId;
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
    routes: [createEnrollmentCodeStateRouteFor({ withActor })],
  });
});
afterAll(async () => server?.close());

function get(id: string, headers: Record<string, string> = {}) {
  return fetch(
    `http://127.0.0.1:${server.port}/api/v1/institution/courses/${id}/enrollment-code/state`,
    { headers: { cookie: `${SESSION_COOKIE_NAME}=${TOKEN}`, ...headers } },
  );
}

it("answers the issued vector with only validUntil, the id lower case", async () => {
  query.mockResolvedValueOnce({
    rows: [{ courseId: ID, validUntil: new Date(ISSUED.current.validUntil) }],
    rowCount: 1,
  });
  const response = await get(ID.toUpperCase(), { "sec-fetch-site": "same-origin" });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual(ISSUED);
  expect(query).toHaveBeenCalledExactlyOnceWith(expect.any(String), [ID]);
});

it("answers the none-or-revoked vector when the course has no active code", async () => {
  query.mockResolvedValueOnce({ rows: [{ courseId: ID, validUntil: null }], rowCount: 1 });
  const response = await get(ID);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(vector("none-or-revoked").response.body);
});

it("never selects the code hash (A-8)", async () => {
  query.mockResolvedValueOnce({ rows: [{ courseId: ID, validUntil: null }], rowCount: 1 });
  await get(ID);
  expect(String(query.mock.calls.at(-1)![0])).not.toContain("code_hash");
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

const ROW = { courseId: ID, validUntil: new Date(ISSUED.current.validUntil) };
const OTHER = "7e1a2b3c-4d5e-4f60-8a71-b2c3d4e5f602";
it.each<{ rows: unknown[]; status: number; code: string }>([
  { rows: [], status: 401, code: "unauthorized" },
  { rows: [{ courseId: null, validUntil: null }], status: 404, code: "not_found" },
  { rows: [ROW, ROW], status: 503, code: "unavailable" },
  { rows: [{ ...ROW, courseId: OTHER }], status: 503, code: "unavailable" },
  { rows: [{ ...ROW, validUntil: ISSUED.current.validUntil }], status: 503, code: "unavailable" },
  { rows: [{ ...ROW, validUntil: new Date(Number.NaN) }], status: 503, code: "unavailable" },
])("answers $status for the reader outcome", async ({ rows, status, code }) => {
  query.mockResolvedValueOnce({ rows, rowCount: rows.length });
  const response = await get(ID);
  expect(response.status).toBe(status);
  expect(await response.json()).toMatchObject({ code });
});

it("answers 503 when the database fails", async () => {
  query.mockRejectedValueOnce(Object.assign(new Error("izmišljeno"), { code: "XX000" }));
  const response = await get(ID);
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ code: "unavailable" });
});

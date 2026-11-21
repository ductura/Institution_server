import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";

import { PilotMetrics } from "../../contracts/index.ts";
import type { ActorTransaction, WithActor } from "../../database/index.ts";

import { createDatabases, createLayers, startServer, type Running } from "../index.ts";
import { createPilotMetricsRouteFor } from "./index.ts";

const PATH = "/api/v1/ops/pilot-metrics";
const TOKEN = "T".repeat(43);
const COOKIE = `__Host-ductus_session=${TOKEN}`;
const AS_OF = new Date("2026-11-20T23:00:00.000Z");
const query = vi.fn();
const withActor: WithActor = (token, run) =>
  run({ query: query.bind(null, token) } as ActorTransaction);
let server: Running;

let closed: Running;
let unconfirmed: Running;

// Step 8 is the real one. `server` lists every account as an operator with a
// confirmed second factor; `closed` has no operator list (the default) and
// `unconfirmed` lists the account without a second factor.
async function start(layers: Parameters<typeof createLayers>[0]): Promise<Running> {
  return startServer({
    host: "127.0.0.1",
    port: 0,
    layers: createLayers(layers),
    databases: createDatabases(),
    routes: [createPilotMetricsRouteFor({ withActor })],
  });
}

beforeAll(async () => {
  const expectedOrigin = "https://ductura.example.invalid";
  server = await start({
    expectedOrigin,
    operators: async () => "listed",
    secondFactor: async () => "confirmed",
  });
  closed = await start({ expectedOrigin });
  unconfirmed = await start({ expectedOrigin, operators: async () => "listed" });
});
afterAll(async () => {
  await closed.close();
  await unconfirmed.close();
});
afterAll(async () => server.close());
beforeEach(() => {
  query.mockReset();
});

function get(path = PATH, headers: Record<string, string> = { cookie: COOKIE }) {
  return fetch(`http://127.0.0.1:${server.port}${path}`, { headers });
}

const ROW = {
  asOf: AS_OF,
  submissionsRecorded: 10,
  submissionsNotRecorded: 5,
  receiptsIssued: 5,
  receiptsPending: 5,
  helpRequests: 0,
  saveProblemReports: null,
  receiptP50Ms: 3000,
  receiptP95Ms: 4800,
};

it("answers only the aggregate numbers, with no identifier and no text", async () => {
  // A column the database might add later never reaches the answer.
  query.mockResolvedValue({
    rows: [{ ...ROW, userId: "izmisljeni-korisnik", text: "Izmišljeno" }],
  });
  const response = await get();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const body: unknown = await response.json();
  expect(body).toEqual({
    asOf: "2026-11-20T23:00:00.000Z",
    minimumGroup: 5,
    submissions: { recorded: 10, notRecorded: 5 },
    receipts: { issued: 5, pending: 5 },
    helpRequests: { total: 0, saveProblems: null },
    receiptTime: { p50Ms: 3000, p95Ms: 4800 },
  });
  expect(JSON.stringify(body)).not.toMatch(/izmisljeni|Izmišljeno|user|student|id"/iu);
  expect(query).toHaveBeenCalledExactlyOnceWith(
    TOKEN,
    expect.stringContaining("app.pilot_metrics()"),
  );
});

it.each([1, 2, 3, 4, 6, 9])(
  "refuses a row with a count of %i (small or not rounded)",
  async (small) => {
    query.mockResolvedValue({ rows: [{ ...ROW, receiptsPending: small }] });
    expect((await get()).status).toBe(503);
  },
);

it.each([
  ["negative count", { submissionsRecorded: -5 }],
  ["fractional count", { helpRequests: 5.5 }],
  ["count as text", { receiptsIssued: "5" }],
  ["negative duration", { receiptP50Ms: -1 }],
  ["missing cutoff", { asOf: null }],
])("refuses an invalid row: %s", async (_name, change) => {
  query.mockResolvedValue({ rows: [{ ...ROW, ...change }] });
  expect((await get()).status).toBe(503);
});

it("refuses an answer of no rows or of two", async () => {
  query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [ROW, ROW] });
  expect((await get()).status).toBe(503);
  expect((await get()).status).toBe(503);
});

it("maps ZD401 of the database to 401", async () => {
  query.mockRejectedValue(Object.assign(new Error("not authenticated"), { code: "ZD401" }));
  const response = await get();
  expect(response.status).toBe(401);
  expect(await response.json()).toMatchObject({ code: "unauthenticated" });
});

it("the contract schema itself refuses every count from 1 to 4 and every other field", async () => {
  const { Value } = await import("@sinclair/typebox/value");
  const { submissions } = PilotMetrics.properties;
  const body = (recorded: number | null) => ({ recorded, notRecorded: 0 });
  for (const ok of [0, 5, 10, null]) expect(Value.Check(submissions, body(ok))).toBe(true);
  for (const small of [1, 2, 3, 4, 6, 9]) expect(Value.Check(submissions, body(small))).toBe(false);
  expect(Value.Check(submissions, { ...body(5), studentId: "izmisljeni" })).toBe(false);
  expect(PilotMetrics.additionalProperties).toBe(false);
});

it.each([
  [PATH, {}, 401],
  [PATH, { cookie: COOKIE, "sec-fetch-site": "cross-site" }, 403],
  [`${PATH}?institution=demo`, { cookie: COOKIE }, 422],
] satisfies [string, Record<string, string>, number][])(
  "rejects an invalid request to %s",
  async (path, headers, status) => {
    expect((await get(path, headers)).status).toBe(status);
    expect(query).not.toHaveBeenCalled();
  },
);

it.each([
  ["no operator list", () => closed],
  ["no confirmed second factor", () => unconfirmed],
] as const)("only an operator reaches the numbers: %s gets 403", async (_name, which) => {
  query.mockResolvedValue({ rows: [ROW] });
  const response = await fetch(`http://127.0.0.1:${which().port}${PATH}`, {
    headers: { cookie: COOKIE },
  });
  expect(response.status).toBe(403);
  expect(query).not.toHaveBeenCalled();
});

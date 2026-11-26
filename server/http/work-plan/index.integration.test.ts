// SRV-F4-PM2-R15: the HTTP edge of the plan of a work over a scripted
// transaction. Who may is the database's (db/main/tests/261); this checks the
// edge: session, work id, media type, body shape and the closed answers.
// Invented data only.
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { ActorTransaction, WithActor } from "../../database/index.ts";
import { createDatabases, createLayers, startServer, type Running } from "../index.ts";

import { createWorkPlanRoutesFor } from "./index.ts";

const ORIGIN = "https://ductura.example.invalid";
const TOKEN = "A".repeat(43);
const AT = new Date("2026-11-26T09:00:00.000Z");
const NODE = "1f0e2d3c-4b5a-4968-8776-655443322110";
const PLAN = {
  question: "Izmišljeno pitanje rada?",
  purposes: [{ nodeId: NODE, purpose: "Izmišljena svrha." }],
  terms: [{ term: "Pojam", definition: "Izmišljena definicija.", kind: "term" }],
};
const ROW = { ...PLAN, updatedAt: AT };
const STATE = { ...PLAN, updatedAt: AT.toISOString() };

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
    routes: createWorkPlanRoutesFor({ withActor }),
  });
});
afterEach(() => server.close());

const plan = (id = "izmisljeni-rad") => `http://127.0.0.1:${server.port}/api/v1/works/${id}/plan`;
const cookie = { cookie: `__Host-ductus_session=${TOKEN}` };
const put = (body: unknown, url = plan(), headers: Record<string, string> = {}) =>
  fetch(url, {
    method: "PUT",
    headers: { origin: ORIGIN, "content-type": "application/json", ...cookie, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

it("reads no plan as a null question, empty lists and a null instant", async () => {
  query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
  const empty = await fetch(plan(), { headers: cookie });
  expect(empty.status).toBe(200);
  expect(await empty.json()).toEqual({ question: null, purposes: [], terms: [], updatedAt: null });
  query.mockResolvedValueOnce({ rows: [ROW], rowCount: 1 });
  expect(await (await fetch(plan(), { headers: cookie })).json()).toEqual(STATE);
  expect(query.mock.calls[1]![0]).toMatch(/collaboration\.get_work_plan\(\$1\)/);
  expect(query.mock.calls[1]![1]).toEqual(["izmisljeni-rad"]);
});

it("writes the whole plan through the RPC and answers it as kept", async () => {
  query.mockResolvedValueOnce({ rows: [ROW], rowCount: 1 });
  const written = await put(PLAN);
  expect(written.status).toBe(200);
  expect(await written.json()).toEqual(STATE);
  expect(query.mock.calls[0]![0]).toMatch(
    /collaboration\.put_work_plan\(\$1, \$2, \$3::jsonb, \$4::jsonb\)/,
  );
  expect(query.mock.calls[0]![1]).toEqual([
    "izmisljeni-rad",
    PLAN.question,
    JSON.stringify(PLAN.purposes),
    JSON.stringify(PLAN.terms),
  ]);
});

it("an empty plan is written as such and answers no plan", async () => {
  query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
  const cleared = await put({ question: null, purposes: [], terms: [] });
  expect(cleared.status).toBe(200);
  expect(await cleared.json()).toEqual({
    question: null,
    purposes: [],
    terms: [],
    updatedAt: null,
  });
  expect(query.mock.calls[0]![1]).toEqual(["izmisljeni-rad", null, "[]", "[]"]);
});

it.each([
  ["question with a space at its end", { ...PLAN, question: "Pitanje " }],
  ["empty question", { ...PLAN, question: "" }],
  ["question of two lines", { ...PLAN, question: "Dva\nretka" }],
  ["question over 300", { ...PLAN, question: "a".repeat(301) }],
  ["question missing", { purposes: [], terms: [] }],
  ["unknown key", { ...PLAN, extra: 1 }],
  ["purpose at a malformed block", { ...PLAN, purposes: [{ nodeId: "x", purpose: "Svrha." }] }],
  ["empty purpose", { ...PLAN, purposes: [{ nodeId: NODE, purpose: "" }] }],
  [
    "purpose that quotes the text",
    { ...PLAN, purposes: [{ nodeId: NODE, purpose: "S.", quote: "q" }] },
  ],
  ["unknown term kind", { ...PLAN, terms: [{ term: "A", definition: "B", kind: "other" }] }],
  ["term over 80", { ...PLAN, terms: [{ term: "t".repeat(81), definition: "B", kind: "term" }] }],
  [
    "definition over 500",
    { ...PLAN, terms: [{ term: "A", definition: "d".repeat(501), kind: "term" }] },
  ],
  [
    "201 purposes",
    {
      ...PLAN,
      purposes: Array.from({ length: 201 }, (_, i) => ({
        nodeId: `1f0e2d3c-4b5a-4968-8776-${String(i).padStart(12, "0")}`,
        purpose: "S.",
      })),
    },
  ],
  ["terms not an array", { ...PLAN, terms: {} }],
])("refuses a plan with a %s as 422 and never reaches the database", async (_name, body) => {
  const refused = await put(body);
  expect(refused.status).toBe(422);
  expect(((await refused.json()) as { code: string }).code).toBe("invalid_input");
  expect(query).not.toHaveBeenCalled();
});

it("answers the closed refusals of the port: 401, 404 for the relation, 422 and 503", async () => {
  for (const [code, status] of [
    ["ZD401", 401],
    ["ZD403", 404],
    ["ZD422", 422],
    ["XX000", 503],
  ] as const) {
    query.mockRejectedValueOnce(Object.assign(new Error("secret text"), { code }));
    const response = await put(PLAN);
    expect(response.status).toBe(status);
    expect(JSON.stringify(await response.json())).not.toContain("secret text");
    query.mockRejectedValueOnce(Object.assign(new Error("secret text"), { code }));
    expect((await fetch(plan(), { headers: cookie })).status).toBe(status);
  }
});

it("a row of an unexpected shape is 503, never passed on", async () => {
  query.mockResolvedValueOnce({ rows: [{ ...ROW, terms: "x" }], rowCount: 1 });
  expect((await fetch(plan(), { headers: cookie })).status).toBe(503);
  query.mockResolvedValueOnce({ rows: [ROW, ROW], rowCount: 2 });
  expect((await fetch(plan(), { headers: cookie })).status).toBe(503);
});

it("needs a session, the media type and a body that is JSON", async () => {
  expect((await fetch(plan())).status).toBe(401);
  expect((await fetch(plan(), { method: "PUT", headers: { origin: ORIGIN } })).status).toBe(401);
  expect((await put(PLAN, plan(), { "content-type": "text/plain" })).status).toBe(415);
  expect((await put("{")).status).toBe(400);
  expect(query).not.toHaveBeenCalled();
});

it("a work id that is not one is the same 404 as another's work and reaches no database", async () => {
  expect((await fetch(plan("%20x"), { headers: cookie })).status).toBe(404);
  expect((await put(PLAN, plan("%00"))).status).toBe(404);
  expect(query).not.toHaveBeenCalled();
});

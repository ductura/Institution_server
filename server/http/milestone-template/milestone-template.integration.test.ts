import { afterEach, expect, it, vi } from "vitest";

import type { WithActor } from "../../database/index.ts";
import { createDatabases, createLayers, startServer, type Running } from "../index.ts";

import { createMilestoneTemplateRoutesFor } from "./index.ts";

const TOKEN = "T".repeat(43);
const COOKIE = `__Host-ductus_session=${TOKEN}`;
const ORIGIN = "https://ductura.example.invalid";
const ID = "00000000-0000-4000-8000-000000001521";
const CREATED = new Date("2026-12-05T10:00:00.000Z");
const ITEMS = [
  { title: "Tema i nacrt", relativeDue: 14, submits: "topic_text" },
  { title: "Prvo poglavlje", submits: "current_version" },
];
const VERSION_ROW = {
  version: 1,
  requireFinalStageApproval: false,
  milestones: ITEMS,
  createdAt: CREATED,
};
const SHOWN = {
  version: 1,
  effectiveFrom: CREATED.toISOString(),
  requireFinalStageApproval: false,
  milestones: ITEMS,
};
const PLAN_ROW = { id: ID, position: 1, title: "Nacrt", dueAt: CREATED, submits: "topic_text" };
const PLAN = {
  id: ID,
  position: 1,
  title: "Nacrt",
  dueAt: CREATED.toISOString(),
  submits: "topic_text",
};
const PUT_BODY = { expectedVersion: 0, requireFinalStageApproval: false, milestones: ITEMS };

let running: Running | undefined;
afterEach(async () => {
  await running?.close();
  running = undefined;
});

type Answer = (sql: string, values?: readonly unknown[]) => object[] | Error;

async function serve(answer: Answer) {
  await running?.close();
  const query = vi.fn(async (sql: string, values?: readonly unknown[]) => {
    const rows = answer(sql, values);
    if (rows instanceof Error) throw rows;
    return rows;
  });
  const withActor: WithActor = (token, run) => {
    expect(token).toBe(TOKEN);
    return run({
      async query<Row>(sql: string, values?: readonly unknown[]) {
        const rows = await query(sql, values);
        return { rows: rows as Row[], rowCount: rows.length };
      },
    });
  };
  running = await startServer({
    host: "127.0.0.1",
    port: 0,
    databases: createDatabases(),
    layers: createLayers({ expectedOrigin: ORIGIN }),
    routes: createMilestoneTemplateRoutesFor({ withActor }),
  });
  const base = `http://127.0.0.1:${running.port}/api/v1`;
  const send = (
    path: string,
    method: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    fetch(`${base}${path}`, {
      method,
      headers: {
        cookie: COOKIE,
        ...(method === "GET" ? {} : { origin: ORIGIN }),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { send, query };
}

const failure = (code: string) => Object.assign(new Error(code), { code });

it("reads the versions of the template for an administrator", async () => {
  const { send, query } = await serve(() => [VERSION_ROW]);
  const response = await send("/institution/milestone-template", "GET");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ current: SHOWN, versions: [SHOWN] });
  expect(query).toHaveBeenCalledOnce();
});

it("has no current version while the institution has none", async () => {
  const { send } = await serve(() => []);
  const response = await send("/institution/milestone-template", "GET");
  expect(await response.json()).toEqual({ current: null, versions: [] });
});

it("refuses a query on the read, a stranger and a missing session", async () => {
  const { send } = await serve(() => failure("ZD403"));
  expect((await send("/institution/milestone-template?x=1", "GET")).status).toBe(422);
  expect((await send("/institution/milestone-template", "GET")).status).toBe(403);
  const anonymous = await fetch(
    `http://127.0.0.1:${running!.port}/api/v1/institution/milestone-template`,
  );
  expect(anonymous.status).toBe(401);
});

it("publishes a version and answers with the stored one", async () => {
  const { send, query } = await serve((sql) =>
    sql.includes("publish_milestone_template") ? [{ version: 1 }] : [VERSION_ROW],
  );
  const response = await send("/institution/milestone-template", "PUT", PUT_BODY);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(SHOWN);
  expect(query.mock.calls[0]).toEqual([
    "SELECT app.publish_milestone_template($1::integer, $2::boolean, $3::jsonb) AS version",
    [0, false, JSON.stringify(ITEMS)],
  ]);
});

it.each([
  ["a stale version", failure("ZD409"), 409],
  ["a stranger", failure("ZD403"), 403],
  ["no session in the database", failure("ZD401"), 401],
  ["a list the database refuses", failure("ZD422"), 422],
])("maps %s on publish", async (_name, error, status) => {
  const { send } = await serve(() => error);
  expect((await send("/institution/milestone-template", "PUT", PUT_BODY)).status).toBe(status);
});

it("refuses an unexpected failure without telling what it was", async () => {
  const { send } = await serve(() => new Error("secret detail"));
  const response = await send("/institution/milestone-template", "PUT", PUT_BODY);
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain("secret detail");
});

it.each([
  ["an unknown key", { ...PUT_BODY, extra: 1 }],
  ["no flag", { expectedVersion: 0, milestones: [] }],
  ["an unknown submits", { ...PUT_BODY, milestones: [{ title: "A", submits: "x" }] }],
  [
    "relativeDue 0",
    { ...PUT_BODY, milestones: [{ title: "A", submits: "topic_text", relativeDue: 0 }] },
  ],
  [
    "relativeDue 1096",
    { ...PUT_BODY, milestones: [{ title: "A", submits: "topic_text", relativeDue: 1096 }] },
  ],
  ["an empty title", { ...PUT_BODY, milestones: [{ title: "", submits: "topic_text" }] }],
  [
    "21 milestones",
    {
      ...PUT_BODY,
      milestones: Array.from({ length: 21 }, () => ({ title: "A", submits: "topic_text" })),
    },
  ],
])("refuses %s before the database", async (_name, body) => {
  const { send, query } = await serve(() => []);
  expect((await send("/institution/milestone-template", "PUT", body)).status).toBe(422);
  expect(query).not.toHaveBeenCalled();
});

it("needs JSON on publish", async () => {
  const { send } = await serve(() => []);
  const wrong = await fetch(
    `http://127.0.0.1:${running!.port}/api/v1/institution/milestone-template`,
    {
      method: "PUT",
      headers: { cookie: COOKIE, origin: ORIGIN, "content-type": "text/plain" },
      body: "x",
    },
  );
  expect(wrong.status).toBe(415);
  void send;
});

it("reads the plan of a work", async () => {
  const { send, query } = await serve(() => [PLAN_ROW]);
  const response = await send("/works/doc%3Aa/milestone-plan", "GET");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ milestones: [PLAN] });
  expect(query.mock.calls[0]![1]).toEqual(["doc:a"]);
});

it("is 404 for a work the caller has no part in", async () => {
  const { send } = await serve(() => failure("ZD404"));
  expect((await send("/works/doc%3Aa/milestone-plan", "GET")).status).toBe(404);
});

it("adds a milestone and answers with the plan", async () => {
  const { send, query } = await serve(() => [PLAN_ROW]);
  const body = { title: "Nacrt", dueAt: "2026-12-30T10:00:00Z", submits: "topic_text" };
  const response = await send("/works/doc%3Aa/milestone-plan/milestones", "POST", body);
  expect(response.status).toBe(201);
  expect(await response.json()).toEqual({ milestones: [PLAN] });
  expect(query.mock.calls[0]![1]).toEqual(["doc:a", "Nacrt", "2026-12-30T10:00:00Z", "topic_text"]);
});

it.each([
  ["the student", failure("ZD403"), 403],
  ["a work with no part", failure("ZD404"), 404],
  ["a submitted work", failure("ZD409"), 409],
])("maps %s on add", async (_name, error, status) => {
  const { send } = await serve(() => error);
  const response = await send("/works/doc%3Aa/milestone-plan/milestones", "POST", {
    title: "Nacrt",
    submits: "topic_text",
  });
  expect(response.status).toBe(status);
});

it("refuses a milestone the contract does not describe", async () => {
  const { send, query } = await serve(() => []);
  for (const body of [
    { title: "Nacrt" },
    { title: "", submits: "topic_text" },
    { title: "A", submits: "topic_text", x: 1 },
  ]) {
    expect((await send("/works/doc%3Aa/milestone-plan/milestones", "POST", body)).status).toBe(422);
  }
  expect(query).not.toHaveBeenCalled();
});

it("applies the template again without a body and refuses one", async () => {
  const { send, query } = await serve(() => [PLAN_ROW]);
  const response = await send("/works/doc%3Aa/milestone-plan/apply-template", "POST");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ milestones: [PLAN] });
  expect(query.mock.calls[0]![1]).toEqual(["doc:a"]);
  const withBody = await send("/works/doc%3Aa/milestone-plan/apply-template", "POST", { x: 1 });
  expect(withBody.status).toBe(413);
});

it("maps a refusal of the template to 409", async () => {
  const { send } = await serve(() => failure("ZD409"));
  expect((await send("/works/doc%3Aa/milestone-plan/apply-template", "POST")).status).toBe(409);
});

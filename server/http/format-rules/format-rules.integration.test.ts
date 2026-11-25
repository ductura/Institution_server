import { afterEach, expect, it, vi } from "vitest";

import type { WithActor } from "../../database/index.ts";
import { createDatabases, createLayers, startServer, type Running } from "../index.ts";

import { createFormatRulesRoutesFor } from "./index.ts";

const TOKEN = "T".repeat(43);
const COOKIE = `__Host-ductus_session=${TOKEN}`;
const ORIGIN = "https://ductura.example.invalid";
const ID = "6f1d2c3a-4b5e-4f60-8a7b-9c0d1e2f3a4b";
const PATH = `/student/assignments/${ID}/format-rules`;
const FROZEN_ROW = {
  version: 2,
  titlePage: ["title", "author"],
  sections: [
    { title: "Uvod", hint: "Predstavite temu." },
    { title: "Zaključak", hint: "" },
  ],
  citationStyle: "fpzg",
};

let running: Running | undefined;
afterEach(async () => {
  await running?.close();
  running = undefined;
});

type Answer = { requirements: object[] | Error; template: object[] | Error };

/** The word range comes from app.my_assignment_requirements, the skeleton from the template. */
async function serve(answer: Answer) {
  await running?.close();
  const query = vi.fn(async (sql: string) => {
    const rows = sql.includes("my_assignment_requirements") ? answer.requirements : answer.template;
    if (rows instanceof Error) throw rows;
    return rows;
  });
  const withActor: WithActor = (token, run) => {
    expect(token).toBe(TOKEN);
    return run({
      async query<Row>(sql: string, values?: readonly unknown[]) {
        const rows = await query(sql);
        void values;
        return { rows: rows as Row[], rowCount: rows.length };
      },
    });
  };
  running = await startServer({
    host: "127.0.0.1",
    port: 0,
    databases: createDatabases(),
    layers: createLayers({ expectedOrigin: ORIGIN }),
    routes: createFormatRulesRoutesFor({ withActor }),
  });
  const base = `http://127.0.0.1:${running.port}/api/v1`;
  const send = (path: string, headers: Record<string, string> = { cookie: COOKIE }) =>
    fetch(`${base}${path}`, { headers });
  return { send, query };
}

const failure = (code: string) => Object.assign(new Error(code), { code });
/** One row of app.my_assignment_requirements; its columns are snake_case. */
const requirementsRow = (outcome: string, min: number | null, max: number | null) => [
  Object.fromEntries([
    ["outcome", outcome],
    ["word_min", min],
    ["word_max", max],
  ]),
];
const RANGE = requirementsRow("found", 800, 1200);
const NOT_ENROLLED = requirementsRow("not_found", null, null);

it("composes the word range with the frozen skeleton", async () => {
  const { send } = await serve({ requirements: RANGE, template: [FROZEN_ROW] });
  const response = await send(PATH);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    wordMin: 800,
    wordMax: 1200,
    minSources: 0,
    requiredSections: ["Uvod", "Zaključak"],
    citationStyle: "fpzg",
    font: null,
    size: null,
    spacing: null,
  });
});

it("keeps the open ends of the word range null and has no sections without a template", async () => {
  const { send } = await serve({
    requirements: requirementsRow("found", null, 500),
    template: [],
  });
  expect(await (await send(PATH)).json()).toMatchObject({
    wordMin: null,
    wordMax: 500,
    requiredSections: [],
    citationStyle: "fpzg",
  });
});

it("answers a foreign assignment as 404 and never reads its template", async () => {
  const { send, query } = await serve({ requirements: NOT_ENROLLED, template: [FROZEN_ROW] });
  const response = await send(PATH);
  expect(response.status).toBe(404);
  expect(await response.text()).not.toContain("Uvod");
  expect(query).toHaveBeenCalledTimes(1);
});

it("still answers the word range for an assignment the template read does not know", async () => {
  const { send } = await serve({ requirements: RANGE, template: failure("ZD403") });
  const response = await send(PATH);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ wordMin: 800, requiredSections: [] });
});

it.each([
  [
    "no session in the database (word range)",
    { requirements: failure("ZD401"), template: [] },
    401,
  ],
  [
    "no session in the database (template)",
    { requirements: RANGE, template: failure("ZD401") },
    401,
  ],
  ["a failing range read", { requirements: new Error("secret detail"), template: [] }, 503],
  ["a failing template read", { requirements: RANGE, template: new Error("secret detail") }, 503],
  ["input the template read refuses", { requirements: RANGE, template: failure("ZD422") }, 503],
])("maps %s", async (_name, answer, status) => {
  const { send } = await serve(answer);
  const response = await send(PATH);
  expect(response.status).toBe(status);
  expect(await response.text()).not.toContain("secret detail");
});

it("answers a malformed assignment id as 404 without asking the database", async () => {
  const { send, query } = await serve({ requirements: RANGE, template: [] });
  expect((await send("/student/assignments/nije-uuid/format-rules")).status).toBe(404);
  expect(query).not.toHaveBeenCalled();
});

it("refuses a query before the database, and needs a session", async () => {
  const { send, query } = await serve({ requirements: RANGE, template: [] });
  expect((await send(`${PATH}?x=1`)).status).toBe(422);
  expect((await send(PATH, {})).status).toBe(401);
  expect(query).not.toHaveBeenCalled();
});

it("reads an upper-case id as its lower-case form", async () => {
  const { send } = await serve({ requirements: RANGE, template: [] });
  expect((await send(`/student/assignments/${ID.toUpperCase()}/format-rules`)).status).toBe(200);
});

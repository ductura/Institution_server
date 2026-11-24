import { afterEach, expect, it, vi } from "vitest";

import type { WithActor } from "../../database/index.ts";
import { createDatabases, createLayers, startServer, type Running } from "../index.ts";

import { createWorkTemplateRoutesFor } from "./index.ts";

const TOKEN = "T".repeat(43);
const COOKIE = `__Host-ductus_session=${TOKEN}`;
const ORIGIN = "https://ductura.example.invalid";
const CREATED = new Date("2026-12-05T10:00:00.000Z");
const SECTIONS = [
  { title: "Uvod", hint: "Predstavite temu." },
  { title: "Zaključak", hint: "" },
];
const VERSION_ROW = {
  version: 1,
  titlePage: ["title", "author"],
  sections: SECTIONS,
  citationStyle: "fpzg",
  createdAt: CREATED,
};
const SHOWN = {
  version: 1,
  effectiveFrom: CREATED.toISOString(),
  titlePage: ["title", "author"],
  sections: SECTIONS,
  citationStyle: "fpzg",
};
const PUT_BODY = {
  expectedVersion: 0,
  titlePage: ["title", "author"],
  sections: SECTIONS,
  citationStyle: "fpzg",
};
const PATH = "/institution/work-templates/seminar_paper";

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
    routes: createWorkTemplateRoutesFor({ withActor }),
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

it("reads the versions of one work type for an administrator", async () => {
  const { send, query } = await serve(() => [VERSION_ROW]);
  const response = await send(PATH, "GET");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ current: SHOWN, versions: [SHOWN] });
  expect(query.mock.calls[0]![1]).toEqual(["seminar_paper"]);
});

it("has no current version while the work type has none", async () => {
  const { send } = await serve(() => []);
  expect(await (await send(PATH, "GET")).json()).toEqual({ current: null, versions: [] });
});

it("refuses a query, an unknown work type, a stranger and a missing session", async () => {
  const { send, query } = await serve(() => failure("ZD403"));
  expect((await send(`${PATH}?x=1`, "GET")).status).toBe(422);
  expect((await send("/institution/work-templates/thesis", "GET")).status).toBe(422);
  expect((await send("/institution/work-templates/thesis", "PUT", PUT_BODY)).status).toBe(422);
  expect(query).not.toHaveBeenCalled();
  expect((await send(PATH, "GET")).status).toBe(403);
  const anonymous = await fetch(`http://127.0.0.1:${running!.port}/api/v1${PATH}`);
  expect(anonymous.status).toBe(401);
});

it("publishes a version and answers with the stored one", async () => {
  const { send, query } = await serve((sql) =>
    sql.includes("publish_work_template") ? [{ version: 1 }] : [VERSION_ROW],
  );
  const response = await send(PATH, "PUT", PUT_BODY);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(SHOWN);
  expect(query.mock.calls[0]![1]).toEqual([
    "seminar_paper",
    0,
    JSON.stringify(PUT_BODY.titlePage),
    JSON.stringify(SECTIONS),
    "fpzg",
  ]);
});

it.each([
  ["a stale version", failure("ZD409"), 409],
  ["a stranger", failure("ZD403"), 403],
  ["no session in the database", failure("ZD401"), 401],
  ["content the database refuses", failure("ZD422"), 422],
])("maps %s on publish", async (_name, error, status) => {
  const { send } = await serve(() => error);
  expect((await send(PATH, "PUT", PUT_BODY)).status).toBe(status);
});

it("refuses an unexpected failure without telling what it was", async () => {
  const { send } = await serve(() => new Error("secret detail"));
  const response = await send(PATH, "PUT", PUT_BODY);
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain("secret detail");
});

it.each([
  ["an unknown key", { ...PUT_BODY, extra: 1 }],
  ["no citation style", { expectedVersion: 0, titlePage: [], sections: [] }],
  ["another citation style", { ...PUT_BODY, citationStyle: "apa" }],
  ["an unknown title page field", { ...PUT_BODY, titlePage: ["isbn"] }],
  [
    "six title page fields",
    { ...PUT_BODY, titlePage: ["title", "author", "mentor", "course", "date", "title"] },
  ],
  ["a section without a hint", { ...PUT_BODY, sections: [{ title: "Uvod" }] }],
  ["an empty section title", { ...PUT_BODY, sections: [{ title: "", hint: "" }] }],
  ["a title of 121 characters", { ...PUT_BODY, sections: [{ title: "a".repeat(121), hint: "" }] }],
  ["a hint of 401 characters", { ...PUT_BODY, sections: [{ title: "A", hint: "a".repeat(401) }] }],
  [
    "31 sections",
    { ...PUT_BODY, sections: Array.from({ length: 31 }, () => ({ title: "A", hint: "" })) },
  ],
])("refuses %s before the database", async (_name, body) => {
  const { send, query } = await serve(() => []);
  expect((await send(PATH, "PUT", body)).status).toBe(422);
  expect(query).not.toHaveBeenCalled();
});

it("needs JSON on publish", async () => {
  await serve(() => []);
  const wrong = await fetch(`http://127.0.0.1:${running!.port}/api/v1${PATH}`, {
    method: "PUT",
    headers: { cookie: COOKIE, origin: ORIGIN, "content-type": "text/plain" },
    body: "x",
  });
  expect(wrong.status).toBe(415);
});

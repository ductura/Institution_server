import { afterEach, expect, it, vi } from "vitest";

import type { WithActor } from "../../database/index.ts";
import { createDatabases, createLayers, startServer, type Running } from "../index.ts";

import { createAssignmentTemplateRoutesFor } from "./index.ts";

const TOKEN = "T".repeat(43);
const COOKIE = `__Host-ductus_session=${TOKEN}`;
const ORIGIN = "https://ductura.example.invalid";
const ID = "6f1d2c3a-4b5e-4f60-8a7b-9c0d1e2f3a4b";
const PUT = `/teacher/assignments/${ID}/template`;
const GET = `/student/assignments/${ID}/template`;
const FROZEN_ROW = {
  version: 2,
  titlePage: ["title", "author"],
  sections: [{ title: "Uvod", hint: "Predstavite temu." }],
  citationStyle: "fpzg",
};

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
    routes: createAssignmentTemplateRoutesFor({ withActor }),
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

it("pins the template for a teacher and answers the version", async () => {
  const { send, query } = await serve(() => [{ version: 2 }]);
  const response = await send(PUT, "PUT", { useInstitutionTemplate: true });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ useInstitutionTemplate: true, version: 2 });
  expect(query.mock.calls[0]![1]).toEqual([ID, true]);
});

it("switches the template off", async () => {
  const { send, query } = await serve(() => [{ version: 0 }]);
  const response = await send(PUT, "PUT", { useInstitutionTemplate: false });
  expect(await response.json()).toEqual({ useInstitutionTemplate: false, version: null });
  expect(query.mock.calls[0]![1]).toEqual([ID, false]);
});

it.each([
  ["a stranger or another's assignment", failure("ZD403"), 404],
  ["no template for the work type yet", failure("ZD409"), 409],
  ["no session in the database", failure("ZD401"), 401],
  ["input the database refuses", failure("ZD422"), 422],
  ["an unexpected failure", new Error("secret detail"), 503],
])("maps %s on the switch", async (_name, error, status) => {
  const { send } = await serve(() => error);
  const response = await send(PUT, "PUT", { useInstitutionTemplate: true });
  expect(response.status).toBe(status);
  expect(await response.text()).not.toContain("secret detail");
});

it.each([
  ["no key", {}],
  ["a string", { useInstitutionTemplate: "yes" }],
  ["an unknown key", { useInstitutionTemplate: true, extra: 1 }],
])("refuses %s before the database", async (_name, body) => {
  const { send, query } = await serve(() => []);
  expect((await send(PUT, "PUT", body)).status).toBe(422);
  expect(query).not.toHaveBeenCalled();
});

it("answers a malformed assignment id as 404 without asking the database", async () => {
  const { send, query } = await serve(() => []);
  expect(
    (await send("/teacher/assignments/nije-uuid/template", "PUT", { useInstitutionTemplate: true }))
      .status,
  ).toBe(404);
  expect((await send("/student/assignments/nije-uuid/template", "GET")).status).toBe(404);
  expect(query).not.toHaveBeenCalled();
});

it("needs JSON and a session on the switch", async () => {
  await serve(() => []);
  const url = `http://127.0.0.1:${running!.port}/api/v1${PUT}`;
  const wrong = await fetch(url, {
    method: "PUT",
    headers: { cookie: COOKIE, origin: ORIGIN, "content-type": "text/plain" },
    body: "x",
  });
  expect(wrong.status).toBe(415);
  const anonymous = await fetch(url, {
    method: "PUT",
    headers: { origin: ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ useInstitutionTemplate: true }),
  });
  expect(anonymous.status).toBe(401);
});

it("reads the frozen template for a student", async () => {
  const { send, query } = await serve(() => [FROZEN_ROW]);
  const response = await send(GET, "GET");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(FROZEN_ROW);
  expect(query.mock.calls[0]![1]).toEqual([ID]);
});

it("answers 404 for an assignment without a template and for a stranger", async () => {
  const none = await serve(() => []);
  expect((await none.send(GET, "GET")).status).toBe(404);
  const stranger = await serve(() => failure("ZD403"));
  expect((await stranger.send(GET, "GET")).status).toBe(404);
});

it("refuses a query on the read and a missing session", async () => {
  const { send, query } = await serve(() => [FROZEN_ROW]);
  expect((await send(`${GET}?x=1`, "GET")).status).toBe(422);
  expect(query).not.toHaveBeenCalled();
  const anonymous = await fetch(`http://127.0.0.1:${running!.port}/api/v1${GET}`);
  expect(anonymous.status).toBe(401);
});

it("answers 503 without detail for an unexpected failure on the read", async () => {
  const { send } = await serve(() => new Error("secret detail"));
  const response = await send(GET, "GET");
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain("secret detail");
});

it("answers 503 when the stored template is outside the contract", async () => {
  const { send } = await serve(() => [{ ...FROZEN_ROW, citationStyle: "apa" }]);
  expect((await send(GET, "GET")).status).toBe(503);
});

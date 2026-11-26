import { afterEach, expect, it, vi } from "vitest";

import type { WithActor } from "../../database/index.ts";
import { createDatabases, createLayers, startServer, type Running } from "../index.ts";

import { createThesisCommitteeRoutesFor } from "./index.ts";

// SRV-V16-POVJERENSTVO-ZAPIS: the adapter over a scripted database. Every person and id is invented.
const TOKEN = "T".repeat(43);
const COOKIE = `__Host-ductus_session=${TOKEN}`;
const ORIGIN = "https://ductura.example.invalid";
const DOC = "doc-izmisljeni-zavrsni-1";
const AT = "2026-11-25T10:00:00.000Z";
const U1 = "00000000-0000-4000-8000-000000000101";
const U2 = "00000000-0000-4000-8000-000000000102";

let running: Running | undefined;
afterEach(async () => {
  await running?.close();
  running = undefined;
});

type Answer = object[] | Error;
async function serve(...answers: Answer[]) {
  await running?.close();
  const query = vi.fn(async (_sql: string, _values?: readonly unknown[]) => {
    const answer = answers.shift() ?? [];
    if (answer instanceof Error) throw answer;
    return answer;
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
    routes: createThesisCommitteeRoutesFor({ withActor }),
  });
  const base = `http://127.0.0.1:${running.port}/api/v1`;
  const send = (
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = { cookie: COOKIE },
    contentType = "application/json",
  ) =>
    fetch(base + path, {
      method,
      headers: { origin: ORIGIN, "content-type": contentType, ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  const get = (path: string) => fetch(base + path, { headers: { cookie: COOKIE } });
  return { send, get, query };
}

const sqlError = (code: string) => Object.assign(new Error("refused"), { code });
const PATH = `/works/${DOC}/thesis-committee`;
const MEMBERS = [
  { userId: U1, name: { givenName: "Marko", familyName: "Izmišljenić" }, role: "chair" },
  { userId: U2, name: null, role: "member" },
];
const SET = { members: MEMBERS, changedAt: new Date(AT) };
const NEVER = { members: [], changedAt: null };
const BODY = {
  members: [
    { userId: U1, role: "chair" },
    { userId: U2, role: "member" },
  ],
};

it("reads the committee: members, a null name stays null, the time as ISO text, the writer is the faculty", async () => {
  const { get, query } = await serve([SET]);
  const response = await get(PATH);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({
    members: MEMBERS,
    changedAt: AT,
    changedByPart: "faculty",
  });
  expect(query.mock.calls[0]?.[1]).toEqual([DOC]);
});

it("reads no committee as an empty list with no time and no writer", async () => {
  const { get } = await serve([NEVER]);
  expect(await (await get(PATH)).json()).toEqual({
    members: [],
    changedAt: null,
    changedByPart: null,
  });
});

it("replaces the list: the document and the whole list go to one RPC as json", async () => {
  const { send, query } = await serve([SET]);
  const response = await send("PUT", PATH, BODY);
  expect(response.status).toBe(200);
  expect(query).toHaveBeenCalledTimes(1);
  expect(query.mock.calls[0]?.[0]).toContain("app.set_work_thesis_committee");
  expect(query.mock.calls[0]?.[1]).toEqual([DOC, JSON.stringify(BODY.members)]);
});

it("an empty list is allowed and reaches the RPC", async () => {
  const { send, query } = await serve([{ members: [], changedAt: new Date(AT) }]);
  const response = await send("PUT", PATH, { members: [] });
  expect(response.status).toBe(200);
  expect(query.mock.calls[0]?.[1]).toEqual([DOC, "[]"]);
});

it.each([
  ["no members", {}],
  [
    "six members",
    {
      members: Array.from({ length: 6 }, (_, i) => ({
        userId: `00000000-0000-4000-8000-00000000010${i}`,
        role: "member",
      })),
    },
  ],
  ["an unknown role", { members: [{ userId: U1, role: "president" }] }],
  ["an id that is no uuid", { members: [{ userId: "nije-uuid", role: "member" }] }],
  [
    "an uppercase id",
    { members: [{ userId: "ABCDEF00-0000-4000-8000-000000000101", role: "member" }] },
  ],
  ["a member with an extra key", { members: [{ userId: U1, role: "member", name: "x" }] }],
  ["an unknown field", { ...BODY, extra: 1 }],
  ["members that are not a list", { members: "x" }],
])("refuses %s with 422 before the database", async (_name, body) => {
  const { send, query } = await serve();
  const response = await send("PUT", PATH, body);
  expect(response.status).toBe(422);
  expect(query).not.toHaveBeenCalled();
});

it.each([
  ["ZD401", 401, "unauthorized"],
  ["ZD403", 403, "forbidden"],
  ["ZD404", 404, "not_found"],
  ["ZD422", 422, "invalid_input"],
])("maps %s from the replacement to %i", async (code, status, word) => {
  const { send } = await serve(sqlError(code));
  const response = await send("PUT", PATH, BODY);
  expect(response.status).toBe(status);
  expect(((await response.json()) as { error: string }).error).toBe(word);
});

it("a reader that is not allowed gets 404, never 403, as the database says", async () => {
  const { get } = await serve(sqlError("ZD404"));
  expect((await get(PATH)).status).toBe(404);
});

it("an error outside the contract is a fault, 503: a stray ZD409 on either route", async () => {
  const { get } = await serve(sqlError("ZD409"));
  expect((await get(PATH)).status).toBe(503);
  const second = await serve(sqlError("ZD409"));
  expect((await second.send("PUT", PATH, BODY)).status).toBe(503);
});

it("a read that is no committee row at all is a fault, 503", async () => {
  const { get } = await serve([]);
  expect((await get(PATH)).status).toBe(503);
});

it("an unknown database fault is 503", async () => {
  const { send } = await serve(new Error("connection lost"));
  expect((await send("PUT", PATH, BODY)).status).toBe(503);
});

it("needs a session on both routes", async () => {
  const { send } = await serve();
  expect((await send("PUT", PATH, BODY, {})).status).toBe(401);
  expect((await send("GET", PATH, undefined, {})).status).toBe(401);
});

it("a body that is not JSON is 415 or 400", async () => {
  const { send, query } = await serve();
  expect((await send("PUT", PATH, "members=x", { cookie: COOKIE }, "text/plain")).status).toBe(415);
  expect((await send("PUT", PATH, "{", { cookie: COOKIE })).status).toBe(400);
  expect(query).not.toHaveBeenCalled();
});

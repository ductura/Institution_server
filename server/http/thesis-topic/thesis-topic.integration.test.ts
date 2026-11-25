import { afterEach, expect, it, vi } from "vitest";

import type { WithActor } from "../../database/index.ts";
import { createDatabases, createLayers, startServer, type Running } from "../index.ts";

import { createThesisTopicRoutesFor } from "./index.ts";

// SRV-V16-TEMA-PRIJEDLOG: the adapter over a scripted database. Every person and id is invented.
const TOKEN = "T".repeat(43);
const COOKIE = `__Host-ductus_session=${TOKEN}`;
const ORIGIN = "https://ductura.example.invalid";
const DOC = "doc-izmisljeni-zavrsni-1";
const AT = "2026-11-24T10:00:00.000Z";
const DECIDED = "2026-11-24T11:00:00.000Z";

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
    routes: createThesisTopicRoutesFor({ withActor }),
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
const PATH = `/works/${DOC}/thesis-topic`;
const NOW = {
  state: "returned",
  version: 2,
  title: "Izmišljena tema",
  summary: "Izmišljeni opis.",
  proposedAt: new Date(AT),
  decision: "returned",
  decisionComment: "Izmišljeni komentar.",
  decidedAt: new Date(DECIDED),
};
const NONE = {
  state: "none",
  version: null,
  title: null,
  summary: null,
  proposedAt: null,
  decision: null,
  decisionComment: null,
  decidedAt: null,
};
const HISTORY = [
  { version: 1, title: "Prva izmišljena tema", summary: "", proposedAt: new Date(AT) },
  { version: 2, title: "Izmišljena tema", summary: "Izmišljeni opis.", proposedAt: new Date(AT) },
];

it("reads the topic with the decision and every version, dates as ISO text", async () => {
  const { get, query } = await serve([NOW], HISTORY);
  const response = await get(PATH);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({
    state: "returned",
    current: { version: 2, title: "Izmišljena tema", summary: "Izmišljeni opis.", proposedAt: AT },
    decision: {
      version: 2,
      decision: "returned",
      comment: "Izmišljeni komentar.",
      decidedAt: DECIDED,
      decidedByPart: "mentor",
    },
    history: [
      { version: 1, title: "Prva izmišljena tema", summary: "", proposedAt: AT },
      { version: 2, title: "Izmišljena tema", summary: "Izmišljeni opis.", proposedAt: AT },
    ],
  });
  expect(query.mock.calls[0]?.[1]).toEqual([DOC]);
});

it("reads no topic as state none with nothing in it", async () => {
  const { get } = await serve([NONE], []);
  const response = await get(PATH);
  expect(await response.json()).toEqual({
    state: "none",
    current: null,
    decision: null,
    history: [],
  });
});

it("proposes: the title and summary go to the RPC and the answer is the topic in force", async () => {
  const { send, query } = await serve(
    [],
    [{ ...NOW, decision: null, decisionComment: null, decidedAt: null, state: "proposed" }],
    HISTORY,
  );
  const response = await send("PUT", PATH, {
    title: "Izmišljena tema",
    summary: "Izmišljeni opis.",
  });
  expect(response.status).toBe(200);
  expect(((await response.json()) as { state: string }).state).toBe("proposed");
  expect(query.mock.calls[0]?.[1]).toEqual([DOC, "Izmišljena tema", "Izmišljeni opis."]);
});

it("a missing summary goes to the RPC as null", async () => {
  const { send, query } = await serve([], [NONE], []);
  await send("PUT", PATH, { title: "Samo naslov" });
  expect(query.mock.calls[0]?.[1]).toEqual([DOC, "Samo naslov", null]);
});

it("decides: version, decision and comment go to the RPC", async () => {
  const { send, query } = await serve([], [NOW], HISTORY);
  const response = await send("POST", `${PATH}/decision`, {
    version: 2,
    decision: "returned",
    comment: "Izmišljeni komentar.",
  });
  expect(response.status).toBe(200);
  expect(query.mock.calls[0]?.[1]).toEqual([DOC, 2, "returned", "Izmišljeni komentar."]);
});

it.each([
  ["no title", { summary: "Samo opis." }],
  ["a blank title", { title: "   " }],
  ["a title over 200 characters", { title: "a".repeat(201) }],
  ["a title with a line break", { title: "Prvi\nDrugi" }],
  ["a summary over 1000 characters", { title: "Naslov", summary: "b".repeat(1001) }],
  ["an unknown field", { title: "Naslov", extra: 1 }],
])("refuses %s with 422 before the database", async (_name, body) => {
  const { send, query } = await serve();
  const response = await send("PUT", PATH, body);
  expect(response.status).toBe(422);
  expect(query).not.toHaveBeenCalled();
});

it.each([
  ["returning without a comment", { version: 2, decision: "returned" }],
  ["a blank comment", { version: 2, decision: "returned", comment: "  " }],
  ["an unknown decision", { version: 2, decision: "graded" }],
  ["version 0", { version: 0, decision: "approved" }],
  ["a missing version", { decision: "approved" }],
  [
    "a comment over 1000 characters",
    { version: 2, decision: "returned", comment: "c".repeat(1001) },
  ],
])("refuses a decision with %s with 422 before the database", async (_name, body) => {
  const { send, query } = await serve();
  const response = await send("POST", `${PATH}/decision`, body);
  expect(response.status).toBe(422);
  expect(query).not.toHaveBeenCalled();
});

it.each([
  ["ZD401", 401, "unauthorized"],
  ["ZD403", 403, "forbidden"],
  ["ZD404", 404, "not_found"],
  ["ZD409", 409, "conflict"],
  ["ZD422", 422, "invalid_input"],
])("maps %s from the proposal to %i", async (code, status, word) => {
  const { send } = await serve(sqlError(code));
  const response = await send("PUT", PATH, { title: "Naslov" });
  expect(response.status).toBe(status);
  expect(((await response.json()) as { error: string }).error).toBe(word);
});

it("maps a stale version to 409 and a stranger to 404 on the decision", async () => {
  const { send } = await serve(sqlError("ZD409"));
  expect(
    (await send("POST", `${PATH}/decision`, { version: 1, decision: "approved" })).status,
  ).toBe(409);
  const second = await serve(sqlError("ZD404"));
  expect(
    (await second.send("POST", `${PATH}/decision`, { version: 1, decision: "approved" })).status,
  ).toBe(404);
});

it("a reader that is not allowed gets 404, never 403, as the database says", async () => {
  const { get } = await serve(sqlError("ZD404"));
  expect((await get(PATH)).status).toBe(404);
});

it("a read answers only the errors of its contract: a stray ZD409 is a fault, 503", async () => {
  const { get } = await serve(sqlError("ZD409"));
  expect((await get(PATH)).status).toBe(503);
});

it("an unknown database fault is 503", async () => {
  const { send } = await serve(new Error("connection lost"));
  const response = await send("PUT", PATH, { title: "Naslov" });
  expect(response.status).toBe(503);
});

it("needs a session on all three routes", async () => {
  const { send } = await serve();
  expect((await send("PUT", PATH, { title: "Naslov" }, {})).status).toBe(401);
  expect(
    (await send("POST", `${PATH}/decision`, { version: 1, decision: "approved" }, {})).status,
  ).toBe(401);
  expect((await send("GET", PATH, undefined, {})).status).toBe(401);
});

it("a body that is not JSON is 415 or 400", async () => {
  const { send, query } = await serve();
  expect((await send("PUT", PATH, "title=x", { cookie: COOKIE }, "text/plain")).status).toBe(415);
  expect((await send("PUT", PATH, "{", { cookie: COOKIE })).status).toBe(400);
  expect(query).not.toHaveBeenCalled();
});

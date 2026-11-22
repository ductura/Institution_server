import { afterEach, expect, it, vi } from "vitest";

import type { WithActor } from "../../database/index.ts";
import { createDatabases, createLayers, startServer, type Running } from "../index.ts";

import { createReturnForRevisionRoutesFor } from "./index.ts";

const TOKEN = "R".repeat(43);
const COOKIE = `__Host-ductus_session=${TOKEN}`;
const ORIGIN = "https://ductura.example.invalid";
const ID = "00000000-0000-4000-8000-000000000a06";
const DUE = "2026-12-10T12:00:00.000Z";
const AT = "2026-12-03T08:00:00.000Z";

let running: Running | undefined;
afterEach(async () => {
  await running?.close();
  running = undefined;
});

const RETURNED = {
  outcome: "returned",
  id: ID,
  attempt: 1,
  comment: "Doradi uvod.",
  revisionDueAt: new Date(DUE),
  returnedAt: new Date(AT),
};

async function serve(answer: object[] | Error) {
  await running?.close();
  const query = vi.fn(async (_sql: string, _values?: readonly unknown[]) => {
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
    routes: createReturnForRevisionRoutesFor({ withActor }),
  });
  const post = (body: unknown, { origin = ORIGIN, cookie = COOKIE, work = "doc%3Aa" } = {}) =>
    fetch(`http://127.0.0.1:${running!.port}/api/v1/works/${work}/return-for-revision`, {
      method: "POST",
      headers: { origin, cookie, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return { post, query };
}

it("returns the work with the comment and the new revision due date", async () => {
  const { post, query } = await serve([RETURNED]);
  const response = await post({ comment: "Doradi uvod.", revisionDueAt: DUE });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    id: ID,
    state: "returned_for_revision",
    round: 1,
    comment: "Doradi uvod.",
    revisionDueAt: DUE,
    returnedAt: AT,
  });
  expect(query).toHaveBeenCalledExactlyOnceWith(
    expect.stringContaining("app.return_work_for_revision($1, $2, $3)"),
    ["doc:a", "Doradi uvod.", DUE],
  );
});

it("takes the revision due date as optional", async () => {
  const { post, query } = await serve([{ ...RETURNED, revisionDueAt: null }]);
  const response = await post({ comment: "Doradi uvod." });
  expect(response.status).toBe(200);
  expect(((await response.json()) as { revisionDueAt: unknown }).revisionDueAt).toBeNull();
  expect(query.mock.calls[0]?.[1]).toEqual(["doc:a", "Doradi uvod.", null]);
});

it("refuses bodies and requests the contract does not accept before the database", async () => {
  const { post, query } = await serve([RETURNED]);
  expect((await post({})).status).toBe(422);
  expect((await post({ comment: "" })).status).toBe(422);
  expect((await post({ comment: "x".repeat(2001) })).status).toBe(422);
  expect((await post({ comment: "a", revisionDueAt: "2026-12-10T12:00:00" })).status).toBe(422);
  expect((await post({ comment: "a", state: "approved" })).status).toBe(422);
  expect((await post({ comment: "a" }, { origin: "https://other.example.invalid" })).status).toBe(
    403,
  );
  expect((await post({ comment: "a" }, { cookie: "" })).status).toBe(401);
  expect((await post({ comment: "a" }, { work: "%00" })).status).toBe(404);
  expect(query).not.toHaveBeenCalled();
});

it.each([
  ["unauthorized", 401, "unauthorized"],
  ["invalid", 422, "invalid_input"],
  ["not_found", 404, "not_found"],
  ["forbidden", 403, "forbidden"],
  ["not_submitted", 409, "conflict"],
])("maps the outcome %s to %i", async (outcome, status, code) => {
  const { post } = await serve([{ outcome }]);
  const response = await post({ comment: "Doradi uvod." });
  expect(response.status).toBe(status);
  expect(await response.json()).toMatchObject({ code });
});

it("answers 503 on a throw and on an answer the database does not complete", async () => {
  const thrown = await serve(new Error("internal"));
  expect((await thrown.post({ comment: "a" })).status).toBe(503);
  const empty = await serve([]);
  expect((await empty.post({ comment: "a" })).status).toBe(503);
  const odd = await serve([{ outcome: "something-else" }]);
  expect((await odd.post({ comment: "a" })).status).toBe(503);
});

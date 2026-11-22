import { afterEach, expect, it, vi } from "vitest";

import type { WithActor } from "../../database/index.ts";
import { createDatabases, createLayers, startServer, type Running } from "../index.ts";

import { createWorkMilestonesRoutesFor } from "./index.ts";

const TOKEN = "M".repeat(43);
const COOKIE = `__Host-ductus_session=${TOKEN}`;
const ORIGIN = "https://ductura.example.invalid";
const ID = "00000000-0000-4000-8000-000000001103";
const DUE = "2026-12-02T12:00:00.000Z";
const MILESTONE = { id: ID, title: "Nacrt", description: "", state: "open" };

let running: Running | undefined;
afterEach(async () => {
  await running?.close();
  running = undefined;
});

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
    routes: createWorkMilestonesRoutesFor({ withActor }),
  });
  const url = `http://127.0.0.1:${running.port}/api/v1/works/doc%3Aa/milestones`;
  const patch = (body: object, origin = ORIGIN) =>
    fetch(`${url}/${ID}`, {
      method: "PATCH",
      headers: { origin, cookie: COOKIE, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return { url, patch, query };
}

it("lists milestones with no request body and preserves an unset deadline", async () => {
  const { url, query } = await serve([{ ...MILESTONE, dueAt: null }]);
  const response = await fetch(url, { headers: { cookie: COOKIE } });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ milestones: [{ ...MILESTONE, dueAt: null }] });
  expect(query).toHaveBeenCalledExactlyOnceWith(
    'SELECT id, title, description, due_at AS "dueAt", state FROM app.read_work_milestones($1)',
    ["doc:a"],
  );
});

it("patches only the requested deadline and returns the milestone", async () => {
  const { patch, query } = await serve([{ ...MILESTONE, dueAt: new Date(DUE) }]);
  const response = await patch({ dueAt: DUE });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ...MILESTONE, dueAt: DUE });
  expect(query).toHaveBeenCalledExactlyOnceWith(
    'SELECT id, title, description, due_at AS "dueAt", state FROM app.set_work_milestone_due($1, $2, $3)',
    ["doc:a", ID, DUE],
  );
});

it("rejects additional fields, missing time zones and foreign origins before the database", async () => {
  const { patch, query } = await serve([]);
  expect((await patch({ dueAt: DUE, state: "approved" })).status).toBe(422);
  expect((await patch({ dueAt: "2026-12-02T12:00:00" })).status).toBe(422);
  expect((await patch({ dueAt: DUE }, "https://other.example.invalid")).status).toBe(403);
  expect(query).not.toHaveBeenCalled();
});

it.each([
  ["ZD401", 401, "unauthorized"],
  ["ZD403", 403, "forbidden"],
  ["ZD404", 404, "not_found"],
  ["ZD409", 409, "conflict"],
  ["22008", 422, "invalid_input"],
])("maps database refusal %s to %i", async (sqlState, status, code) => {
  const { patch } = await serve(Object.assign(new Error("internal"), { code: sqlState }));
  const response = await patch({ dueAt: DUE });
  expect(response.status).toBe(status);
  expect(await response.json()).toMatchObject({ code });
});

// SRV-1520: the state routes.
const STATE = {
  id: ID,
  title: "Nacrt",
  description: "",
  dueAt: new Date(DUE),
  state: "submitted",
  everSubmitted: true,
  submittedRevisionId: "12",
  submittedAt: new Date("2026-12-02T09:30:00.000Z"),
  revisionComment: null,
  revisionDueAt: null,
  revisionRequestedAt: null,
  approvedAt: null,
  approvalMessage: null,
};
const STATE_JSON = {
  ...STATE,
  dueAt: DUE,
  submittedRevisionId: 12,
  submittedAt: "2026-12-02T09:30:00.000Z",
};

async function call(method: string, tail: string, body?: object) {
  const { query } = await serve([STATE]);
  const response = await fetch(`http://127.0.0.1:${running!.port}/api/v1/works/doc%3Aa/${tail}`, {
    method,
    headers: {
      origin: ORIGIN,
      cookie: COOKIE,
      ...(body && { "content-type": "application/json" }),
    },
    ...(body && { body: JSON.stringify(body) }),
  });
  return { response, query };
}

it("reads the states of the milestones of a work", async () => {
  const { response, query } = await call("GET", "milestone-states");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ milestones: [STATE_JSON] });
  expect(query.mock.calls[0]?.[1]).toEqual(["doc:a"]);
  expect(query.mock.calls[0]?.[0]).toContain("app.read_work_milestone_states($1)");
});

it("submits a milestone with no body and returns its state", async () => {
  const { response, query } = await call("POST", `milestones/${ID}/submit`);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(STATE_JSON);
  expect(query.mock.calls[0]?.[0]).toContain("app.submit_work_milestone($1, $2)");
  expect(query.mock.calls[0]?.[1]).toEqual(["doc:a", ID]);
});

it("asks for a revision with the comment and the reminder deadline", async () => {
  const { response, query } = await call("POST", `milestones/${ID}/request-revision`, {
    comment: "Dopuni uvod.",
    revisionDueAt: DUE,
  });
  expect(response.status).toBe(200);
  expect(query.mock.calls[0]?.[1]).toEqual(["doc:a", ID, "Dopuni uvod.", DUE]);
});

it("requires a comment and refuses extra fields when asking for a revision", async () => {
  expect((await call("POST", `milestones/${ID}/request-revision`, {})).response.status).toBe(422);
  const extra = await call("POST", `milestones/${ID}/request-revision`, { comment: "x", grade: 5 });
  expect(extra.response.status).toBe(422);
  expect(extra.query).not.toHaveBeenCalled();
});

it("approves with an optional message", async () => {
  const none = await call("POST", `milestones/${ID}/approve`, {});
  expect(none.response.status).toBe(200);
  expect(none.query.mock.calls[0]?.[1]).toEqual(["doc:a", ID, null]);
  const some = await call("POST", `milestones/${ID}/approve`, { message: "Dobro." });
  expect(some.query.mock.calls[0]?.[1]).toEqual(["doc:a", ID, "Dobro."]);
});

it("changes the title and deadline through the details route", async () => {
  const { response, query } = await call("PATCH", `milestones/${ID}/details`, {
    title: "Prvi nacrt",
  });
  expect(response.status).toBe(200);
  expect(query.mock.calls[0]?.[1]).toEqual(["doc:a", ID, "Prvi nacrt", null]);
});

it("deletes a milestone with 204 and refuses a body", async () => {
  const { response, query } = await call("DELETE", `milestones/${ID}`);
  expect(response.status).toBe(204);
  expect(query.mock.calls[0]?.[1]).toEqual(["doc:a", ID]);
});

it("maps a refused transition to 409", async () => {
  const { query } = await serve(Object.assign(new Error("internal"), { code: "ZD409" }));
  void query;
  const response = await fetch(
    `http://127.0.0.1:${running!.port}/api/v1/works/doc%3Aa/milestones/${ID}/submit`,
    { method: "POST", headers: { origin: ORIGIN, cookie: COOKIE } },
  );
  expect(response.status).toBe(409);
});

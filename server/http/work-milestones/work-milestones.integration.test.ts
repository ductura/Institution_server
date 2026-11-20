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
  const { url, query } = await serve([{ ...MILESTONE, due_at: null }]);
  const response = await fetch(url, { headers: { cookie: COOKIE } });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ milestones: [{ ...MILESTONE, dueAt: null }] });
  expect(query).toHaveBeenCalledExactlyOnceWith("SELECT * FROM app.read_work_milestones($1)", [
    "doc:a",
  ]);
});

it("patches only the requested deadline and returns the milestone", async () => {
  const { patch, query } = await serve([{ ...MILESTONE, due_at: new Date(DUE) }]);
  const response = await patch({ dueAt: DUE });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ...MILESTONE, dueAt: DUE });
  expect(query).toHaveBeenCalledExactlyOnceWith(
    "SELECT * FROM app.set_work_milestone_due($1, $2, $3)",
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

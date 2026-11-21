import { afterEach, expect, it, vi } from "vitest";

import type { WithActor } from "../database/index.ts";

import { createDatabases, createLayers, type Running, startServer } from "./index.ts";
import { createStudentDeadlineHistoryRouteFor } from "./student-deadline-history.ts";

const ASSIGNMENT = "00000000-0000-4000-8000-0000000000a1";
const TOKEN = "a".repeat(43);
const COOKIE = { cookie: `__Host-ductus_session=${TOKEN}` };
const HISTORY_ROW = {
  id: "00000000-0000-4000-8000-0000000000f1",
  scope: "one",
  previousDueAt: new Date("2026-12-20T23:00:00Z"),
  dueAt: new Date("2026-12-27T23:00:00Z"),
  reasonId: "justified",
  createdAt: new Date("2026-11-21T09:15:00Z"),
};

let running: Running | undefined;
afterEach(async () => running?.close());

async function start(withActor: WithActor): Promise<string> {
  running = await startServer({
    host: "127.0.0.1",
    port: 0,
    databases: createDatabases(),
    layers: createLayers({ expectedOrigin: "http://localhost" }),
    routes: [createStudentDeadlineHistoryRouteFor({ withActor })],
  });
  return `http://127.0.0.1:${running.port}/api/v1/student/assignments`;
}

it("reads only by session and assignment and sends the approved history fields without caching", async () => {
  const query = vi.fn().mockResolvedValue({
    rows: [{ ...HISTORY_ROW, studentId: "not-an-api-field", createdBy: "not-an-api-field" }],
    rowCount: 1,
  });
  const base = await start(async (token, run) => {
    expect(token).toBe(TOKEN);
    return run({ query });
  });
  const answer = await fetch(`${base}/${ASSIGNMENT.toUpperCase()}/deadline-extensions`, {
    headers: COOKIE,
  });
  expect(answer.status).toBe(200);
  expect(answer.headers.get("cache-control")).toBe("no-store");
  expect(await answer.json()).toEqual({ extensions: [JSON.parse(JSON.stringify(HISTORY_ROW))] });
  expect(query).toHaveBeenCalledExactlyOnceWith(
    expect.stringContaining("institution.student_deadline_history($1::uuid)"),
    [ASSIGNMENT],
  );
});

it.each([
  ["ZD401", 401],
  ["ZD403", 404],
  ["XX000", 503],
])("maps the database response %s to %i", async (code, status) => {
  const base = await start(async () => {
    throw Object.assign(new Error("invented database error"), { code });
  });
  const answer = await fetch(`${base}/${ASSIGNMENT}/deadline-extensions`, { headers: COOKIE });
  expect(answer.status).toBe(status);
});

it("rejects missing sessions and malformed ids before reading history", async () => {
  const read = vi.fn();
  const base = await start(async () => {
    read();
    throw new Error("unexpected read");
  });
  expect((await fetch(`${base}/${ASSIGNMENT}/deadline-extensions`)).status).toBe(401);
  expect((await fetch(`${base}/nije-uuid/deadline-extensions`, { headers: COOKIE })).status).toBe(
    404,
  );
  expect(read).not.toHaveBeenCalled();
});

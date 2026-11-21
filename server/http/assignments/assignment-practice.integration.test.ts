import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { ROUTES } from "../../contracts/index.ts";
import type { WithActor } from "../../database/index.ts";
import { SESSION_COOKIE_NAME } from "../../session/index.ts";
import { createDatabases, createLayers, sendJson, startServer } from "../index.ts";

import { createAssignmentGradeRouteFor, excludePracticeAssignment } from "./index.ts";

const ID = "a04d5e6f-7081-4c93-9da4-e5f607182904";
const GRADE = `/api/v1/teacher/assignments/${ID}/grade`;
const query = vi.fn();
const withActor: WithActor = (_token, run) => run({ query });
const main = { withActor };
const cookie = `${SESSION_COOKIE_NAME}=${"A".repeat(43)}`;
const exports = [
  ["teacher.merlin-roster.get", `/api/v1/teacher/assignments/${ID}/merlin/roster`],
  ["teacher.merlin-roster-csv.get", `/api/v1/teacher/assignments/${ID}/merlin/csv`],
  ["work.export-pdf.get", `/api/v1/assignments/${ID}/works/demo-rad/export/pdf`],
] as const;

let server: Awaited<ReturnType<typeof startServer>>;
beforeAll(async () => {
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    layers: createLayers({ expectedOrigin: "https://ductura.example.invalid" }),
    databases: createDatabases(),
    routes: [
      createAssignmentGradeRouteFor(main),
      ...exports.map(([id]) =>
        excludePracticeAssignment(
          {
            contract: ROUTES.find((route) => route.id === id)!,
            handle: async (_request, response) => sendJson(response, 200, { delegated: true }),
          },
          main,
        ),
      ),
    ],
  });
});
afterAll(async () => server?.close());

function get(path: string) {
  return fetch(`http://127.0.0.1:${server.port}${path}`, { headers: { cookie } });
}

it.each([
  ["eligible", 200, { eligible: true }],
  ["practice", 409, { code: "practice_assignment", messageKey: "errors.practiceAssignment" }],
  ["not_found", 404, { code: "not_found" }],
  ["unauthorized", 401, { code: "unauthorized" }],
])("reads %s through the grade route", async (state, status, body) => {
  query.mockResolvedValueOnce({ rows: [{ state }], rowCount: 1 });
  const response = await get(GRADE);
  expect(response.status).toBe(status);
  expect(await response.json()).toMatchObject(body);
  expect(query).toHaveBeenLastCalledWith(expect.stringContaining("assignment_grade_state"), [ID]);
});

it.each(exports)(
  "filters practice through %s and delegates regular assignments",
  async (_id, path) => {
    query.mockResolvedValueOnce({ rows: [{ practice: true }], rowCount: 1 });
    const practice = await get(path);
    expect(practice.status).toBe(404);
    expect(await practice.json()).toMatchObject({ code: "not_found" });
    expect(query).toHaveBeenLastCalledWith(expect.stringContaining("a.is_practice"), [ID]);

    query.mockResolvedValueOnce({ rows: [{ practice: null }], rowCount: 1 });
    const hidden = await get(path);
    expect(hidden.status).toBe(404);

    query.mockResolvedValueOnce({ rows: [{ practice: false }], rowCount: 1 });
    const regular = await get(path);
    expect(regular.status).toBe(200);
    expect(await regular.json()).toEqual({ delegated: true });
  },
);

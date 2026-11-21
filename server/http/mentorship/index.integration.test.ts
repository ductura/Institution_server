import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { ActorTransaction, WithActor } from "../../database/index.ts";
import { createDatabases, createLayers, startServer, type Running } from "../index.ts";

import { createMentorshipRequestRoutesFor } from "./index.ts";

// SRV-1407: the HTTP side of the mentorship request moves over a stand-in
// database; the database rules themselves are pgTAP 189 and 104.
const ORIGIN = "https://ductura.example.invalid";
const STUDENT = "s".repeat(43);
const TEACHER = "t".repeat(43);
const REQUEST_ID = "00000000-0000-4000-8000-0000000014a1";
const MENTORSHIP_ID = "00000000-0000-4000-8000-0000000014b1";
const TEACHER_ID = "00000000-0000-4000-8000-0000000014c1";
const PATH = "/api/v1/mentorship-requests";
const query = vi.fn<(token: string, sql: string, values?: readonly unknown[]) => unknown[]>();
const withActor: WithActor = (token, run) =>
  run({
    query: async (sql, values) => {
      const rows = sql.includes("identity.touch_current_session")
        ? [{ touched: false }]
        : query(token!, sql, values);
      return { rows, rowCount: rows.length };
    },
  } as ActorTransaction);
const refusal = (code: string) =>
  Object.assign(new Error("refused"), { code }) as Error & { code: string };

let server: Running;
beforeAll(async () => {
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    databases: createDatabases(),
    layers: createLayers({ expectedOrigin: ORIGIN }),
    routes: createMentorshipRequestRoutesFor({ withActor }),
  });
});
afterAll(async () => server.close());
beforeEach(() => {
  query.mockReset();
});

function call(path: string, token?: string, body?: string, contentType = "application/json") {
  const headers = new Headers({ origin: ORIGIN, "sec-fetch-site": "same-origin" });
  if (token !== undefined) headers.set("cookie", `__Host-ductus_session=${token}`);
  if (body !== undefined) headers.set("content-type", contentType);
  return fetch(`http://127.0.0.1:${server.port}${path}`, {
    method: "POST",
    headers,
    ...(body === undefined ? {} : { body }),
  });
}

describe("mentorship request moves", () => {
  it("the student's request creates an open request and no mentorship", async () => {
    query.mockReturnValueOnce([{ id: REQUEST_ID }]);
    const body = JSON.stringify({ teacherId: TEACHER_ID.toUpperCase(), workType: "master_thesis" });
    const response = await call(PATH, STUDENT, body);
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ requestId: REQUEST_ID, state: "requested" });
    expect(query).toHaveBeenCalledWith(
      STUDENT,
      "SELECT institution.request_mentorship($1::uuid, $2::text) AS id",
      [TEACHER_ID, "master_thesis"],
    );
  });

  it("approving twice answers the same mentorship (the database makes it idempotent)", async () => {
    query.mockReturnValue([{ id: MENTORSHIP_ID }]);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await call(`${PATH}/${REQUEST_ID.toUpperCase()}/approve`, TEACHER);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        requestId: REQUEST_ID,
        state: "approved",
        mentorshipId: MENTORSHIP_ID,
      });
    }
    expect(query).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenCalledWith(
      TEACHER,
      "SELECT app.approve_mentorship_request_once($1::uuid) AS id",
      [REQUEST_ID],
    );
  });

  it.each([
    ["the student approving the own request", STUDENT, "ZD403", 404, "not_found"],
    ["another institution's teacher", TEACHER, "ZD403", 404, "not_found"],
    ["a declined or withdrawn request", TEACHER, "ZD409", 409, "conflict"],
    ["no faculty rule for the kind", TEACHER, "ZD503", 503, "unavailable"],
    ["no session in the database", TEACHER, "ZD401", 401, "unauthorized"],
  ])("approval refused for %s", async (_name, token, code, status, word) => {
    query.mockImplementationOnce(() => {
      throw refusal(code);
    });
    const response = await call(`${PATH}/${REQUEST_ID}/approve`, token);
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error: word });
  });

  it("decline passes the reason; declining again answers the same", async () => {
    query.mockReturnValueOnce([{ done: true }]).mockReturnValueOnce([{ done: false }]);
    const first = await call(
      `${PATH}/${REQUEST_ID}/decline`,
      TEACHER,
      JSON.stringify({ reason: "Popunjeno." }),
    );
    const again = await call(`${PATH}/${REQUEST_ID}/decline`, TEACHER, "{}");
    for (const response of [first, again]) {
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ requestId: REQUEST_ID, state: "declined" });
    }
    expect(query.mock.calls.map((c) => c[2])).toEqual([
      [REQUEST_ID, "Popunjeno."],
      [REQUEST_ID, null],
    ]);
  });

  it("withdraw answers withdrawn, also when it already was", async () => {
    query.mockReturnValueOnce([{ done: true }]).mockReturnValueOnce([{ done: false }]);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await call(`${PATH}/${REQUEST_ID}/withdraw`, STUDENT);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ requestId: REQUEST_ID, state: "withdrawn" });
    }
  });

  it("refuses before the database: no cookie, a malformed id, a bad body", async () => {
    expect((await call(`${PATH}/${REQUEST_ID}/approve`)).status).toBe(401);
    expect((await call(`${PATH}/nije-uuid/approve`, TEACHER)).status).toBe(404);
    expect(
      (await call(PATH, STUDENT, JSON.stringify({ teacherId: TEACHER_ID, workType: "essay" })))
        .status,
    ).toBe(422);
    expect((await call(PATH, STUDENT, "{", "application/json")).status).toBe(400);
    expect((await call(PATH, STUDENT, "{}", "text/plain")).status).toBe(415);
    expect(
      (await call(`${PATH}/${REQUEST_ID}/decline`, TEACHER, JSON.stringify({ reason: " " })))
        .status,
    ).toBe(422);
    expect(query).not.toHaveBeenCalled();
  });

  it("an unexpected database error is 503", async () => {
    query.mockImplementationOnce(() => {
      throw new Error("connection lost");
    });
    const response = await call(`${PATH}/${REQUEST_ID}/withdraw`, STUDENT);
    expect(response.status).toBe(503);
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { ActorTransaction, WithActor } from "../../database/index.ts";
import { createDatabases, createLayers, startServer, type Running } from "../index.ts";

import { createTeachingTeamRoutesFor } from "./index.ts";

const ORIGIN = "https://ductura.example.invalid";
const TOKEN = "t".repeat(43);
const COURSE = "c0000000-0000-4000-8000-000000000001";
const GROUP = "9a000000-0000-4000-8000-00000000000a";
const HOLDER = "7e000000-0000-4000-8000-000000000001";
const ASSISTANT = "7e000000-0000-4000-8000-000000000002";
const STUDENT = "5a000000-0000-4000-8000-000000000001";
const TEAM = `/api/v1/courses/${COURSE}/team`;
const MEMBERS = `/api/v1/courses/${COURSE}/groups/${GROUP}/members`;

const query = vi.fn<(token: string, sql: string, values?: readonly unknown[]) => unknown[]>();
const withActor: WithActor = (token, run) =>
  run({
    query: async (sql, values) => {
      const rows = sql.includes("identity.touch_current_session")
        ? [{ touched: false }]
        : query(token!, sql, values);
      return { rows };
    },
  } as ActorTransaction);

let server: Running;
beforeAll(async () => {
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    databases: createDatabases(),
    layers: createLayers({ expectedOrigin: ORIGIN }),
    routes: createTeachingTeamRoutesFor({ withActor }),
  });
});
afterAll(async () => server.close());
beforeEach(() => {
  query.mockReset();
});

function call(method: string, path: string, body?: string, overrides?: Record<string, string>) {
  return fetch(`http://127.0.0.1:${server.port}${path}`, {
    method,
    headers: {
      cookie: `__Host-ductus_session=${TOKEN}`,
      origin: ORIGIN,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
      ...overrides,
    },
    ...(body === undefined ? {} : { body }),
  });
}

describe("teaching team routing", () => {
  it("uses the cookie actor and returns the roster privately", async () => {
    const roster = { holderId: HOLDER, assistantIds: [ASSISTANT] };
    query.mockReturnValue([roster]);
    const response = await call("GET", TEAM);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(roster);
    expect(query).toHaveBeenCalledWith(
      TOKEN,
      expect.stringContaining("institution.read_teaching_team"),
      [COURSE],
    );
  });

  it("passes both replacement lists to the group RPC in one actor transaction", async () => {
    query.mockReturnValue([]);
    const response = await call(
      "PUT",
      MEMBERS,
      JSON.stringify({ assistantIds: [ASSISTANT], studentIds: [STUDENT] }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ updated: true });
    expect(query).toHaveBeenCalledExactlyOnceWith(
      TOKEN,
      expect.stringContaining("institution.replace_teaching_group_members"),
      [COURSE, GROUP, [ASSISTANT], [STUDENT]],
    );
  });

  it("passes an empty roster to the team RPC for removal", async () => {
    query.mockReturnValue([]);
    expect((await call("POST", TEAM, '{"assistantIds":[]}')).status).toBe(200);
    expect(query).toHaveBeenCalledExactlyOnceWith(
      TOKEN,
      expect.stringContaining("institution.replace_course_assistants"),
      [COURSE, []],
    );
  });

  it.each([
    ["missing list", "POST", TEAM, "{}", 422],
    ["invalid ID", "POST", TEAM, '{"assistantIds":["x"]}', 422],
    [
      "duplicate ID with different case",
      "POST",
      TEAM,
      JSON.stringify({ assistantIds: [ASSISTANT, ASSISTANT.toUpperCase()] }),
      422,
    ],
    ["unknown actor field", "POST", TEAM, '{"assistantIds":[],"holderId":"x"}', 422],
    [
      "too many entries",
      "POST",
      TEAM,
      JSON.stringify({ assistantIds: Array(501).fill(ASSISTANT) }),
      422,
    ],
    ["missing students", "PUT", MEMBERS, '{"assistantIds":[]}', 422],
    ["malformed course", "GET", "/api/v1/courses/no/team", undefined, 422],
    [
      "malformed group",
      "PUT",
      MEMBERS.replace(GROUP, "no"),
      '{"assistantIds":[],"studentIds":[]}',
      422,
    ],
    ["malformed JSON", "POST", TEAM, "{", 400],
  ])("rejects %s before invoking the database", async (_name, method, path, body, status) => {
    expect((await call(method, path, body)).status).toBe(status);
    expect(query).not.toHaveBeenCalled();
  });

  it("requires a session and a same-origin mutation", async () => {
    expect((await call("GET", TEAM, undefined, { cookie: "" })).status).toBe(401);
    expect(
      (await call("POST", TEAM, '{"assistantIds":[]}', { origin: "https://other.invalid" })).status,
    ).toBe(403);
    expect(
      (await call("POST", TEAM, '{"assistantIds":[]}', { "content-type": "text/plain" })).status,
    ).toBe(415);
    expect(query).not.toHaveBeenCalled();
  });

  it.each([
    ["POST", TEAM, '{"assistantIds":[]}', "ZD403", 403, "forbidden"],
    ["PUT", MEMBERS, '{"assistantIds":[],"studentIds":[]}', "ZD409", 409, "conflict"],
    ["GET", TEAM, undefined, "ZD401", 401, "unauthorized"],
  ])("maps the RPC refusal for %s", async (method, path, body, code, status, word) => {
    query.mockImplementationOnce(() => {
      throw Object.assign(new Error("refused"), { code });
    });
    const response = await call(method, path, body);
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ code: word, status });
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { ActorTransaction, WithActor } from "../../database/index.ts";
import { createDatabases, createLayers, startServer, type Running } from "../index.ts";

import { createConsultationSlotRoutesFor } from "./index.ts";

const ORIGIN = "https://ductura.example.invalid";
const STUDENT = "s".repeat(43);
const TEACHER = "t".repeat(43);
const STRANGER = "x".repeat(43);
const ID = "00000000-0000-4000-8000-000000000001";
const PATH = "/api/v1/works/doc-izmisljeni/consultation-slots";
const ITEM = `${PATH}/${ID}`;
const START = "2026-12-04T12:00:00.000Z";
const NEXT = "2026-12-05T13:00:00.000Z";
const PROPOSED = "2026-11-20T11:11:00.000Z";
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

let server: Running;
beforeAll(async () => {
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    databases: createDatabases(),
    layers: createLayers({ expectedOrigin: ORIGIN }),
    routes: createConsultationSlotRoutesFor({ withActor }),
  });
});
afterAll(async () => server.close());
beforeEach(() => {
  query.mockReset();
});

function call(method: string, path: string, token?: string, body?: string, origin = ORIGIN) {
  const headers = new Headers({ origin });
  if (token !== undefined) headers.set("cookie", `__Host-ductus_session=${token}`);
  if (body !== undefined) headers.set("content-type", "application/json");
  return fetch(`http://127.0.0.1:${server.port}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body }),
  });
}

function dbSlot(state: string, startsAt = START) {
  return [{ id: ID, startsAt: new Date(startsAt), proposedAt: new Date(PROPOSED), state }];
}

describe("work consultation slots", () => {
  it("returns an empty list and creates a student's request", async () => {
    query.mockReturnValueOnce([]).mockReturnValueOnce(dbSlot("requested"));
    const empty = await call("GET", PATH, STUDENT);
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ slots: [] });

    const created = await call("POST", PATH, STUDENT, JSON.stringify({ startsAt: START }));
    expect(created.status).toBe(201);
    expect(created.headers.get("cache-control")).toBe("no-store");
    expect(await created.json()).toEqual({
      id: ID,
      startsAt: START,
      proposedAt: PROPOSED,
      state: "requested",
    });
    expect(query).toHaveBeenNthCalledWith(
      2,
      STUDENT,
      expect.stringContaining("institution.request_consultation_slot($1, $2::timestamptz)"),
      ["doc-izmisljeni", START],
    );
  });

  it.each([
    [TEACHER, { action: "confirm" }, "confirmed", START, null],
    [TEACHER, { action: "counter", startsAt: NEXT }, "countered", NEXT, NEXT],
    [STUDENT, { action: "accept" }, "confirmed", NEXT, null],
  ] as const)(
    "passes the transition to the database for %s %j",
    async (token, input, state, startsAt, time) => {
      query.mockReturnValueOnce(dbSlot(state, startsAt));
      const updated = await call("PATCH", ITEM, token, JSON.stringify(input));
      expect(updated.status).toBe(200);
      expect(await updated.json()).toEqual({ id: ID, startsAt, proposedAt: PROPOSED, state });
      expect(query).toHaveBeenCalledWith(
        token,
        expect.stringContaining(
          "institution.act_on_consultation_slot($1, $2::uuid, $3, $4::timestamptz)",
        ),
        ["doc-izmisljeni", ID, input.action, time],
      );
    },
  );

  it.each([
    ["POST", PATH, undefined, "{}", 401],
    ["GET", PATH.replace("doc-izmisljeni", "%00"), STUDENT, undefined, 404],
    ["PATCH", `${PATH}/neispravan-id`, TEACHER, "{}", 404],
    ["POST", PATH, STUDENT, "{", 400],
    ["POST", PATH, STUDENT, '{"startsAt":"2026-12-04"}', 422],
    ["POST", PATH, STUDENT, JSON.stringify({ startsAt: START, state: "confirmed" }), 422],
    ["PATCH", ITEM, TEACHER, '{"action":"counter"}', 422],
    ["PATCH", ITEM, TEACHER, JSON.stringify({ action: "confirm", startsAt: START }), 422],
    ["PATCH", ITEM, STUDENT, '{"action":"request"}', 422],
  ] as const)(
    "refuses an invalid %s %s before querying the database",
    async (method, path, token, body, status) => {
      expect((await call(method, path, token, body)).status).toBe(status);
      expect(query).not.toHaveBeenCalled();
    },
  );

  it("refuses a cross-origin PATCH before querying the database", async () => {
    const response = await call(
      "PATCH",
      ITEM,
      TEACHER,
      '{"action":"confirm"}',
      "https://druga.invalid",
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "origin_mismatch" });
    expect(query).not.toHaveBeenCalled();
  });

  it.each([
    ["GET", PATH, STRANGER, undefined, "ZD403", 403, "forbidden"],
    ["PATCH", ITEM, STUDENT, '{"action":"confirm"}', "ZD403", 403, "forbidden"],
    ["PATCH", ITEM, TEACHER, '{"action":"confirm"}', "ZD409", 409, "conflict"],
    ["POST", PATH, STUDENT, '{"startsAt":"2026-02-30T12:00:00Z"}', "22008", 422, "invalid_input"],
  ] as const)(
    "uses the database refusal for %s %s",
    async (method, path, token, body, dbCode, status, code) => {
      query.mockImplementationOnce(() => {
        throw Object.assign(new Error("test refusal"), { code: dbCode });
      });
      const response = await call(method, path, token, body);
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ code });
    },
  );
});

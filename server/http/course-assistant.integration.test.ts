// The assistant switch per course and its availability (SRV-ASIST-PREKIDAC) on
// a real server with the real pipeline, over a fake port: a teacher reads and
// sets the switch, a body that is not exactly {enabled} is refused before the
// port, a malformed id never reaches the port, refusals read as 404, and the
// availability is true only when the server has a provider AND the database
// says available. All values are invented.
import { afterEach, describe, expect, it } from "vitest";

import type { CourseAssistantPort } from "../database/index.ts";

import { createCourseAssistantRoutes } from "./course-assistant.ts";
import { createDatabases, createLayers, type Running, startServer } from "./index.ts";

const ORIGIN = "https://ductura.example.invalid";
const COURSE = "00000000-0000-4000-8000-0000000000c1";
const ASSIGNMENT = "00000000-0000-4000-8000-0000000000a1";
const COOKIE = "__Host-ductus_session=izmisljeni-token-nastavnika-000000000000001";

let running: Running | undefined;
const calls: unknown[][] = [];
let reply: () => Promise<unknown> = async () => ({ status: "not_found" });

async function start(providerPresent = true): Promise<string> {
  const port = {
    read: (...args: unknown[]) => (calls.push(["read", ...args]), reply()),
    set: (...args: unknown[]) => (calls.push(["set", ...args]), reply()),
    available: (...args: unknown[]) => (calls.push(["available", ...args]), reply()),
    requests: (...args: unknown[]) => (calls.push(["requests", ...args]), reply()),
    readLimit: (...args: unknown[]) => (calls.push(["readLimit", ...args]), reply()),
    setLimit: (...args: unknown[]) => (calls.push(["setLimit", ...args]), reply()),
  } as unknown as CourseAssistantPort;
  running = await startServer({
    host: "127.0.0.1",
    port: 0,
    databases: createDatabases(),
    layers: createLayers({ expectedOrigin: ORIGIN }),
    routes: createCourseAssistantRoutes({ port, providerPresent }),
  });
  return `http://127.0.0.1:${running.port}/api/v1`;
}

afterEach(async () => {
  calls.length = 0;
  reply = async () => ({ status: "not_found" });
  await running?.close();
  running = undefined;
});

const get = (base: string, path: string, cookie: string | null = COOKIE) =>
  fetch(`${base}${path}`, {
    headers: { "sec-fetch-site": "same-origin", ...(cookie === null ? {} : { cookie }) },
  });
const put = (base: string, path: string, body: string) =>
  fetch(`${base}${path}`, {
    method: "PUT",
    headers: {
      cookie: COOKIE,
      origin: ORIGIN,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
    },
    body,
  });

describe("teacher.course-assistant", () => {
  it("reads the switch of the course", async () => {
    const base = await start();
    reply = async () => ({ status: "read", enabled: false });
    const response = await get(base, `/teacher/courses/${COURSE}/assistant`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ enabled: false });
    expect(calls).toEqual([["read", "izmisljeni-token-nastavnika-000000000000001", COURSE]]);
  });

  it("sets the switch, sending exactly the state, the id in lower case", async () => {
    const base = await start();
    reply = async () => ({ status: "read", enabled: false });
    const response = await put(
      base,
      `/teacher/courses/${COURSE.toUpperCase()}/assistant`,
      JSON.stringify({ enabled: false }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ enabled: false });
    expect(calls).toEqual([["set", "izmisljeni-token-nastavnika-000000000000001", COURSE, false]]);
  });

  it.each([
    ['{"enabled":"false"}', 422],
    ['{"enabled":true,"courseId":"x"}', 422],
    ["{}", 422],
    ['{"enabled":', 400],
  ])("a body %s is %i and reaches no port", async (body, status) => {
    const base = await start();
    expect((await put(base, `/teacher/courses/${COURSE}/assistant`, body)).status).toBe(status);
    expect(calls).toEqual([]);
  });

  it("a malformed course is 404 and reaches no port", async () => {
    const base = await start();
    expect((await get(base, "/teacher/courses/nije-uuid/assistant")).status).toBe(404);
    expect(calls).toEqual([]);
  });

  it("a refusal of the database is 404, a lost session 401, an invalid state 422", async () => {
    const base = await start();
    const path = `/teacher/courses/${COURSE}/assistant`;
    reply = async () => ({ status: "not_found" });
    expect((await get(base, path)).status).toBe(404);
    reply = async () => ({ status: "unauthorized" });
    expect((await get(base, path)).status).toBe(401);
    reply = async () => ({ status: "invalid_input" });
    expect((await put(base, path, '{"enabled":true}')).status).toBe(422);
  });

  it("no session is 401 and reaches no port", async () => {
    const base = await start();
    expect((await get(base, `/teacher/courses/${COURSE}/assistant`, null)).status).toBe(401);
    expect(calls).toEqual([]);
  });

  it("an answer outside the contract or a failing port is 503", async () => {
    const base = await start();
    const path = `/teacher/courses/${COURSE}/assistant`;
    reply = async () => ({ status: "read", enabled: "yes" });
    expect((await get(base, path)).status).toBe(503);
    reply = async () => {
      throw new Error("izmisljeni kvar");
    };
    expect((await get(base, path)).status).toBe(503);
  });
});

describe("student.assignment-assistant.get", () => {
  const path = `/student/assignments/${ASSIGNMENT}/assistant`;

  it.each([
    [true, true, true],
    [true, false, false],
    [false, true, false],
    [false, false, false],
  ])("provider %s and database %s: assistantEnabled %s", async (provider, available, expected) => {
    const base = await start(provider);
    reply = async () => ({ status: "read", available });
    const response = await get(base, path);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ assistantEnabled: expected });
  });

  it("without a provider the relation is still checked: a stranger reads 404", async () => {
    const base = await start(false);
    reply = async () => ({ status: "not_found" });
    expect((await get(base, path)).status).toBe(404);
    expect(calls).toEqual([
      ["available", "izmisljeni-token-nastavnika-000000000000001", ASSIGNMENT],
    ]);
  });

  it("a malformed assignment is 404 and reaches no port; a cross-site read is 403", async () => {
    const base = await start();
    expect((await get(base, "/student/assignments/nije-uuid/assistant")).status).toBe(404);
    const cross = await fetch(`${base}${path}`, {
      headers: { cookie: COOKIE, "sec-fetch-site": "cross-site" },
    });
    expect(cross.status).toBe(403);
    expect(calls).toEqual([]);
  });
});

// SRV-ASIST-BROJAC: the daily request count of a student.
describe("student.assignment-assistant-requests.get", () => {
  const path = `/student/assignments/${ASSIGNMENT}/assistant/requests`;

  it.each([
    [20, 3],
    [null, 0],
  ])("limit %s and used %s are answered as they are", async (limit, used) => {
    const base = await start(false);
    reply = async () => ({ status: "read", limit, used });
    const response = await get(base, path);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ limit, used });
    expect(calls).toEqual([
      ["requests", "izmisljeni-token-nastavnika-000000000000001", ASSIGNMENT],
    ]);
  });

  it("a refusal is 404, a lost session 401", async () => {
    const base = await start();
    reply = async () => ({ status: "not_found" });
    expect((await get(base, path)).status).toBe(404);
    reply = async () => ({ status: "unauthorized" });
    expect((await get(base, path)).status).toBe(401);
  });

  it("an answer outside the contract or a failing port is 503", async () => {
    const base = await start();
    reply = async () => ({ status: "read", limit: 0, used: 1 });
    expect((await get(base, path)).status).toBe(503);
    reply = async () => ({ status: "read", limit: 5, used: -1 });
    expect((await get(base, path)).status).toBe(503);
    reply = async () => {
      throw new Error("izmisljeni kvar");
    };
    expect((await get(base, path)).status).toBe(503);
  });

  it("a malformed assignment, no session and a cross-site read reach no port", async () => {
    const base = await start();
    expect((await get(base, "/student/assignments/nije-uuid/assistant/requests")).status).toBe(404);
    expect((await get(base, path, null)).status).toBe(401);
    const cross = await fetch(`${base}${path}`, {
      headers: { cookie: COOKIE, "sec-fetch-site": "cross-site" },
    });
    expect(cross.status).toBe(403);
    expect(calls).toEqual([]);
  });
});

// SRV-ASIST-LIMIT-ADMIN: the administrator's request limit of the institution.
describe("institution.assistant-request-limit", () => {
  const path = "/institution/assistant/request-limit";
  const TOKEN = "izmisljeni-token-nastavnika-000000000000001";

  it.each([
    [3, 20],
    [0, null],
  ])("reads version %s and limit %s as they are", async (version, limit) => {
    const base = await start();
    reply = async () => ({ status: "read", version, limit });
    const response = await get(base, path);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ version, limit });
    expect(calls).toEqual([["readLimit", TOKEN]]);
  });

  it.each([5, null])("sets limit %s on the version seen", async (limit) => {
    const base = await start();
    reply = async () => ({ status: "read", version: 4, limit });
    const response = await put(base, path, JSON.stringify({ expectedVersion: 3, limit }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ version: 4, limit });
    expect(calls).toEqual([["setLimit", TOKEN, 3, limit]]);
  });

  it.each([
    ["forbidden", 403],
    ["unauthorized", 401],
    ["conflict", 409],
    ["invalid_input", 422],
  ])("a refusal %s of the port is %s", async (status, code) => {
    const base = await start();
    reply = async () => ({ status });
    expect((await get(base, path)).status).toBe(code);
    expect((await put(base, path, '{"expectedVersion":0,"limit":5}')).status).toBe(code);
  });

  it.each([
    ["a limit of 0", '{"expectedVersion":0,"limit":0}'],
    ["a fractional limit", '{"expectedVersion":0,"limit":1.5}'],
    ["a negative version", '{"expectedVersion":-1,"limit":5}'],
    ["no version", '{"limit":5}'],
    ["no limit key", '{"expectedVersion":0}'],
    ["an institution in the body", '{"expectedVersion":0,"limit":5,"institutionId":"x"}'],
    ["a limit as text", '{"expectedVersion":0,"limit":"5"}'],
  ])("%s is 422 before the port", async (_name, body) => {
    const base = await start();
    expect((await put(base, path, body)).status).toBe(422);
    expect(calls).toEqual([]);
  });

  it("an answer outside the contract or a failing port is 503", async () => {
    const base = await start();
    reply = async () => ({ status: "read", version: 1, limit: 0 });
    expect((await get(base, path)).status).toBe(503);
    reply = async () => ({ status: "read", version: -1, limit: 5 });
    expect((await put(base, path, '{"expectedVersion":0,"limit":5}')).status).toBe(503);
    reply = async () => {
      throw new Error("izmisljeni kvar");
    };
    expect((await get(base, path)).status).toBe(503);
  });

  it("no session and a cross-site read reach no port", async () => {
    const base = await start();
    expect((await get(base, path, null)).status).toBe(401);
    const cross = await fetch(`${base}${path}`, {
      headers: { cookie: COOKIE, "sec-fetch-site": "cross-site" },
    });
    expect(cross.status).toBe(403);
    expect(calls).toEqual([]);
  });
});

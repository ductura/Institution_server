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

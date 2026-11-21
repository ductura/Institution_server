import { afterEach, expect, it, vi } from "vitest";

import { ROUTES } from "../../contracts/index.ts";
import { SESSION_COOKIE_NAME } from "../../session/index.ts";
import { createDatabases, createLayers, startServer, type Route } from "../index.ts";
import {
  createAccountRateLimiter,
  createAddressRateLimiter,
  readRateLimitConfig,
} from "./index.ts";

const FIRST_SESSION = "a".repeat(43);
const SECOND_SESSION = "b".repeat(43);
const OTHER_USER = "c".repeat(43);
const UNKNOWN_SESSION = "d".repeat(43);
const FAILED_LOOKUP = "e".repeat(43);
const SOURCES = "/api/v1/student/assignments/demo-a/sources";
const ASSIGNMENTS = "/api/v1/student/assignments";
const HEALTH = "/api/v1/health";
const DEFAULT_PER_ACCOUNT = "DUCTURA_RATE_LIMIT_DEFAULT_PER_ACCOUNT";
const DEFAULT_PER_IP = "DUCTURA_RATE_LIMIT_DEFAULT_PER_IP";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function start(perIp = "3000") {
  const { limits } = readRateLimitConfig({
    [DEFAULT_PER_ACCOUNT]: "1",
    [DEFAULT_PER_IP]: perIp,
  });
  let time = 0;
  const now = () => time;
  const currentActor = vi.fn(async (token: string) => {
    if (token === FAILED_LOOKUP) throw new Error("synthetic lookup failure");
    if (token === UNKNOWN_SESSION) return { userId: null, institutionId: null };
    return { userId: token === OTHER_USER ? "demo-b" : "demo-a", institutionId: "demo-faculty" };
  });
  const handle = vi.fn<Route["handle"]>(async (_request, response) => {
    response.writeHead(200).end();
  });
  const routes = ROUTES.filter(({ id }) =>
    ["student.assignments.get", "student.work-sources.get", "platform.health.get"].includes(id),
  ).map((contract) => ({ contract, handle }));
  const running = await startServer({
    host: "127.0.0.1",
    port: 0,
    databases: createDatabases(),
    layers: createLayers({
      expectedOrigin: null,
      rateLimiter: createAddressRateLimiter(limits, now),
    }),
    routes: createAccountRateLimiter(
      limits,
      {
        currentActor,
        currentActorWithInstitution: async () => ({
          userId: null,
          institutionId: null,
          institutionSlug: null,
        }),
      },
      now,
    )(routes),
  });
  close = running.close;
  const get = (path: string, token?: string) =>
    fetch(`http://127.0.0.1:${running.port}${path}`, {
      headers: token === undefined ? {} : { cookie: `${SESSION_COOKIE_NAME}=${token}` },
    });
  return { get, currentActor, handle, advance: (ms: number) => (time += ms) };
}

it("shares a quota across sessions, route parameters and queries while isolating routes and users", async () => {
  const { get, handle, advance } = await start();
  expect((await get(SOURCES, FIRST_SESSION)).status).toBe(200);
  const denied = await get(SOURCES.replace("demo-a", "demo-b") + "?page=2", SECOND_SESSION);
  expect(denied.status).toBe(429);
  expect(denied.headers.get("Retry-After")).toBe("60");
  expect(await denied.json()).toMatchObject({
    code: "too_many_requests",
    messageKey: "errors.tooManyRequests",
  });
  expect(handle).toHaveBeenCalledTimes(1);
  expect((await get(ASSIGNMENTS, SECOND_SESSION)).status).toBe(200);
  expect((await get(SOURCES, OTHER_USER)).status).toBe(200);
  advance(59_999);
  expect((await get(SOURCES, FIRST_SESSION)).headers.get("Retry-After")).toBe("1");
  advance(1);
  expect((await get(SOURCES, SECOND_SESSION)).status).toBe(200);
});

it("allows only one concurrent request for the last place in the same quota", async () => {
  const { get, handle } = await start();
  const responses = await Promise.all([get(SOURCES, FIRST_SESSION), get(SOURCES, SECOND_SESSION)]);
  expect(responses.map(({ status }) => status).sort()).toEqual([200, 429]);
  expect(handle).toHaveBeenCalledTimes(1);
});

it("checks IP first and leaves public and unidentified requests to their own handlers", async () => {
  const { get, currentActor } = await start("4");
  expect((await get(HEALTH, FIRST_SESSION)).status).toBe(200);
  expect((await get(SOURCES)).status).toBe(200);
  expect((await get(SOURCES, "malformed")).status).toBe(200);
  expect((await get(SOURCES, UNKNOWN_SESSION)).status).toBe(200);
  expect((await get(SOURCES, FIRST_SESSION)).status).toBe(429);
  expect(currentActor.mock.calls).toEqual([[UNKNOWN_SESSION]]);
});

it("returns a temporary failure before the handler when the account cannot be verified", async () => {
  const { get, handle } = await start();
  expect((await get(SOURCES, FAILED_LOOKUP)).status).toBe(503);
  expect(handle).not.toHaveBeenCalled();
});

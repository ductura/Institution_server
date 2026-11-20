import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";

import type { ActorTransaction, WithActor } from "../../database/index.ts";
import { createDatabases, createLayers, type Running, startServer } from "../index.ts";

import { createSettingsReadRoutes } from "./index.ts";

const TOKEN = "A".repeat(43);
const COOKIE = `__Host-ductus_session=${TOKEN}`;
const CATALOGUE = "/api/v1/settings/catalogue";
const VALUES = "/api/v1/settings/values";
const COURSE = "00000000-0000-4000-8000-000000000001";
const DATE = "2026-11-20T10:00:00.000Z";
const query = vi.fn();
const currentActor = vi.fn();
const withActor: WithActor = (token, run) => {
  expect(token).toBe(TOKEN);
  return run({ query } as ActorTransaction);
};
let server: Running;

beforeAll(async () => {
  const databases = createDatabases();
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    layers: createLayers({ expectedOrigin: null }),
    databases,
    routes: createSettingsReadRoutes({
      withActor,
      actorReader: { ...databases.main.actorReader, currentActor },
    }),
  });
});
beforeEach(() => {
  query.mockReset();
  currentActor.mockReset();
});
afterAll(async () => server?.close());

const get = (path: string, cookie = COOKIE) =>
  fetch(`http://127.0.0.1:${server.port}${path}`, { headers: { cookie } });

it.each([CATALOGUE, `${VALUES}?level=personal`])("requires a session for %s", async (path) => {
  for (const cookie of ["", "__Host-ductus_session=demo-invalid"]) {
    expect((await get(path, cookie)).status).toBe(401);
  }
  expect(query).not.toHaveBeenCalled();
  expect(currentActor).not.toHaveBeenCalled();
});

it("returns the catalogue only with a live session", async () => {
  currentActor.mockResolvedValueOnce({ userId: null, institutionId: null });
  expect((await get(CATALOGUE)).status).toBe(401);
  currentActor.mockResolvedValueOnce({ userId: COURSE, institutionId: COURSE });
  const response = await get(CATALOGUE);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toMatchObject({
    keys: expect.arrayContaining([
      { key: "notifications.email", levels: ["personal"], kind: "boolean", default: true },
    ]),
  });
});

it("returns stored rows and the default that applies without them", async () => {
  query.mockResolvedValueOnce({
    rows: [{ key: "notifications.email", value: false, bound: null, updated_at: new Date(DATE) }],
  });
  const response = await get(`${VALUES}?level=personal`);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    level: "personal",
    course: null,
    values: [{ key: "notifications.email", value: false, bound: null, updatedAt: DATE }],
    inherited: [
      { key: "notifications.email", value: true, source: "default", bound: null },
      { key: "display.reduced_motion", value: false, source: "default", bound: null },
    ],
  });
  expect(query).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("settings.read_values"), [
    "personal",
    null,
  ]);
});

it("returns only editor defaults when an institution has no saved editor settings", async () => {
  query.mockResolvedValueOnce({
    rows: [{ editorOnly: true, key: null, value: null, bound: null, updated_at: null }],
  });
  const response = await get(`${VALUES}?level=institution`);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    level: "institution",
    course: null,
    values: [],
    inherited: [
      { key: "citation.style", value: "fpzg", source: "default", bound: null },
      { key: "lekta.profile", value: "fpzg-opci-akademski-rad", source: "default", bound: null },
    ],
  });
});

it.each([
  "",
  "level=",
  "level=global",
  "level=personal&level=course",
  "level=personal&foreign=x",
  "level=course",
  "level=course&course=wrong",
  `level=personal&course=${COURSE}`,
  `level=course&course=${COURSE}&course=${COURSE}`,
])("refuses an invalid query before touching the database (%s)", async (queryString) => {
  expect((await get(`${VALUES}?${queryString}`)).status).toBe(422);
  expect(query).not.toHaveBeenCalled();
});

it.each([
  ["ZD401", 401],
  ["ZD403", 404],
  ["ZD422", 422],
  ["08006", 503],
])("maps database code %s to %i", async (code, status) => {
  query.mockRejectedValueOnce(Object.assign(new Error("synthetic database error"), { code }));
  const response = await get(`${VALUES}?level=course&course=${COURSE}`);
  expect(response.status).toBe(status);
  expect(await response.text()).not.toContain("synthetic database error");
});

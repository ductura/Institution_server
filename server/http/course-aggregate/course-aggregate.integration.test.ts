import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";

import type { ActorTransaction, WithActor } from "../../database/index.ts";

import { createDatabases, createLayers, startServer, type Running } from "../index.ts";
import { createCourseAggregateRouteFor } from "./index.ts";

const ID = "00000000-0000-4000-8000-0000000000a1";
const PATH = `/api/v1/courses/${ID}/aggregate`;
const TOKEN = "T".repeat(43);
const COOKIE = `__Host-ductus_session=${TOKEN}`;
const query = vi.fn();
const withActor: WithActor = (token, run) =>
  run({ query: query.bind(null, token) } as ActorTransaction);
let server: Running;

beforeAll(async () => {
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    layers: createLayers({ expectedOrigin: "https://ductura.example.invalid" }),
    databases: createDatabases(),
    routes: [createCourseAggregateRouteFor({ withActor })],
  });
});
afterAll(async () => server.close());
beforeEach(() => {
  query.mockReset();
});

function get(path = PATH, headers: Record<string, string> = { cookie: COOKIE }) {
  return fetch(`http://127.0.0.1:${server.port}${path}`, { headers });
}

it.each([
  [0, 0, 0, true],
  [1, 0, 0, true],
  [2, 0, 0, true],
  [3, 0, 0, true],
  [4, 0, 0, true],
  [5, 0, 0, false],
  [0, 5, 0, false],
  [0, 0, 5, false],
  [4, 5, 5, true], // cohort minus started
  [5, 4, 5, true], // started minus submitted
  [5, 5, 4, true], // submitted alone
  [0, 1, 5, true], // started minus submitted, with empty not-started stage
  [5, 5, 5, false],
] as const)(
  "protects the partition (%i, %i, %i)",
  async (notStarted, inProgress, submitted, hidden) => {
    query.mockResolvedValue({
      rows: [
        {
          status: "ok",
          covered: true,
          notStarted,
          inProgress,
          submitted,
          studentId: "izmisljeni-student",
          name: "Izmišljeno ime",
        },
      ],
    });
    const response = await get();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(
      hidden
        ? { status: "suppressed" }
        : {
            status: "available",
            started: inProgress + submitted,
            submitted,
            stages: { notStarted, inProgress, submitted },
          },
    );
    expect(query).toHaveBeenCalledExactlyOnceWith(TOKEN, expect.any(String), [ID]);
  },
);

it("suppresses an incomplete course snapshot", async () => {
  query.mockResolvedValue({
    rows: [{ status: "ok", covered: false, notStarted: 8, inProgress: 6, submitted: 5 }],
  });
  expect(await (await get()).json()).toEqual({ status: "suppressed" });
});

it("decodes the course id once and passes a normalized UUID", async () => {
  query.mockResolvedValue({ rows: [{ status: "not_found" }] });
  const encoded = `%30${ID.toUpperCase().slice(1)}`;
  expect((await get(PATH.replace(ID, encoded))).status).toBe(404);
  expect(query).toHaveBeenCalledExactlyOnceWith(TOKEN, expect.any(String), [ID]);
});

it.each([
  ["unauthenticated", 401],
  ["not_found", 404],
])("maps the database decision %s", async (status, code) => {
  query.mockResolvedValue({ rows: [{ status }] });
  expect((await get()).status).toBe(code);
});

it.each(["bad-id", "%ZZ", "%2F", "%2530", `${ID}%0A`])("rejects malformed id %s", async (id) => {
  expect((await get(PATH.replace(ID, id))).status).toBe(404);
  expect(query).not.toHaveBeenCalled();
});

it.each([
  [PATH, {}, 401],
  [PATH, { cookie: COOKIE, "sec-fetch-site": "cross-site" }, 403],
  [`${PATH}?groupId=demo`, { cookie: COOKIE }, 422],
] satisfies [string, Record<string, string>, number][])(
  "rejects an invalid request to %s",
  async (path, headers, status) => {
    expect((await get(path, headers)).status).toBe(status);
    expect(query).not.toHaveBeenCalled();
  },
);

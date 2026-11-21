import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { afterEach, expect, it, vi } from "vitest";

import {
  createDatabases,
  createLayers,
  type ReadyReport,
  type Route,
  startServer,
} from "../index.ts";
import { createStatusRoute, createStatusRouteFor } from "./index.ts";

const READY: ReadyReport = {
  ready: true,
  capabilities: { database: "ok", storage: "ok", signing: "nije_konfigurirano" },
  codes: { signing: "demo-private-code" },
};
const START = "2026-12-15T20:00:00.000Z";
const END = "2026-12-15T21:00:00.000Z";
if (!FormatRegistry.Has("date-time")) {
  FormatRegistry.Set("date-time", (value) => {
    const at = new Date(value);
    return Number.isFinite(at.getTime()) && at.toISOString() === value;
  });
}
let close: (() => Promise<void>) | undefined;
afterEach(async () => close?.());

async function serve(route: Route) {
  const running = await startServer({
    host: "127.0.0.1",
    port: 0,
    layers: createLayers({ expectedOrigin: null }),
    databases: createDatabases(),
    routes: [route],
  });
  close = () => running.close();
  return () => fetch(`http://127.0.0.1:${running.port}/api/v1/status`);
}

it("answers anonymous callers using one refresh and a closed projection", async () => {
  const check = vi.fn(async () => READY);
  const query = vi.fn().mockResolvedValue({
    rows: [
      { startsAt: new Date(START), endsAt: new Date(END), privateNote: "demo-person.invalid" },
    ],
  });
  const route = createStatusRouteFor(
    {
      withActor: (token, use) => {
        expect(token).toBeNull();
        return use({ query });
      },
    },
    check,
    () => false,
  );
  expect(route.contract.access).toBe("anyone");
  const get = await serve(route);
  const responses = await Promise.all([get(), get(), get()]);
  const bodies: unknown[] = await Promise.all(responses.map((response) => response.json()));
  const expected = {
    checkedAt: expect.any(String),
    components: { writing: "nije_ukljuceno", submission: "nije_ukljuceno", mentorView: "radi" },
    maintenanceWindows: [{ startsAt: START, endsAt: END }],
  };
  for (const response of responses) {
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.has("set-cookie")).toBe(false);
  }
  expect(bodies).toEqual([expected, expected, expected]);
  expect(check).toHaveBeenCalledTimes(1);
  expect(query).toHaveBeenCalledTimes(2);
  expect(query.mock.calls[1]?.[0]).toContain("identity.public_maintenance_windows()");

  const schema = route.contract.responses[0]?.body;
  if (!schema || typeof schema !== "object") throw new Error("missing response schema");
  expect(Value.Check(schema, bodies[0])).toBe(true);
  const body = { ...expected, checkedAt: START };
  expect(Value.Check(schema, { ...body, email: "demo-person.invalid" })).toBe(false);
  expect(
    Value.Check(schema, {
      ...body,
      components: { ...body.components, email: "demo-person.invalid" },
    }),
  ).toBe(false);
  expect(
    Value.Check(schema, {
      ...body,
      maintenanceWindows: [{ startsAt: START, endsAt: END, email: "demo-person.invalid" }],
    }),
  ).toBe(false);
  expect(
    Value.Check(schema, {
      ...body,
      maintenanceWindows: [{ startsAt: "demo-person.invalid", endsAt: END }],
    }),
  ).toBe(false);
});

it("answers degraded availability without reading the schedule when the database is down", async () => {
  const readWindows = vi.fn(async () => []);
  const get = await serve(
    createStatusRoute({
      check: async () => ({
        ...READY,
        ready: false,
        capabilities: { ...READY.capabilities, database: "nedostupno" },
      }),
      draining: () => false,
      readWindows,
    }),
  );
  expect(await (await get()).json()).toEqual({
    checkedAt: expect.any(String),
    components: { writing: "ne_radi", submission: "ne_radi", mentorView: "ne_radi" },
  });
  expect(readWindows).not.toHaveBeenCalled();
});

it.each(["throws", "times out"])(
  "keeps availability when reading the schedule %s",
  async (failure) => {
    const get = await serve(
      createStatusRoute({
        check: async () => READY,
        draining: () => false,
        readWindows: async () => {
          if (failure === "throws") throw new Error("demo-person.invalid");
          return new Promise(() => {});
        },
      }),
    );
    const response = await get();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      checkedAt: expect.any(String),
      components: { writing: "nije_ukljuceno", submission: "nije_ukljuceno", mentorView: "radi" },
    });
  },
);

it("returns the existing empty 503 if readiness fails or draining starts", async () => {
  const check = vi.fn(async () => {
    throw new Error("demo-person.invalid");
  });
  let draining = false;
  const get = await serve(
    createStatusRoute({ check, draining: () => draining, readWindows: async () => [] }),
  );
  const response = await get();
  expect(response.status).toBe(503);
  expect(await response.text()).toBe("");
  draining = true;
  expect((await get()).status).toBe(503);
  expect(check).toHaveBeenCalledTimes(1);
});

import { beforeEach, describe, expect, it, vi } from "vitest";

// S-1B-c (DAN-778), contract I7: closePools ends every pool this process
// opened, once, and afterwards nothing reaches a database. The driver is a
// fake; the URLs are invented and never dialled.
const pools = vi.hoisted(() => [] as { end: ReturnType<typeof vi.fn> }[]);
vi.mock("pg", () => {
  class Pool {
    end = vi.fn(async () => undefined);
    constructor() {
      pools.push(this);
    }
    on(): this {
      return this;
    }
    query = vi.fn(async () => Promise.reject(new Error("fake pool")));
    connect = vi.fn(async () => Promise.reject(new Error("fake pool")));
  }
  // The driver exports the class under its own name.
  return { default: Object.fromEntries([["Pool", Pool]]) };
});

import { backchannelLogout, closePools, openSession, withActor } from "./index.ts";

beforeEach(() => {
  vi.stubEnv("APP_DATABASE_URL", "postgres://app:invented@db.invalid:5432/ductura");
  vi.stubEnv("AUTH_DATABASE_URL", "postgres://auth:invented@db.invalid:5432/ductura");
});

describe("closePools", () => {
  it("ends the application and auth pools once, then refuses every way in", async () => {
    await expect(withActor("invented-token", async () => undefined)).rejects.toThrow();
    await expect(openSession({} as Parameters<typeof openSession>[0])).rejects.toThrow();
    expect(pools).toHaveLength(2);

    await closePools();
    expect(pools.map((pool) => pool.end.mock.calls.length)).toEqual([1, 1]);

    const closed = /database pools are closed/u;
    await expect(withActor("invented-token", async () => undefined)).rejects.toThrow(closed);
    await expect(openSession({} as Parameters<typeof openSession>[0])).rejects.toThrow(closed);
    await expect(backchannelLogout({} as Parameters<typeof backchannelLogout>[0])).rejects.toThrow(
      closed,
    );
    expect(pools).toHaveLength(2);
  });
});

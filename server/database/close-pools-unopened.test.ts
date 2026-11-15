import { describe, expect, it, vi } from "vitest";

// S-1B-c (DAN-778), contract I7: a pool never opened is not opened to be
// closed, and none opens after closePools. A separate file, so no other test
// has opened a pool in this module instance.
const created = vi.hoisted(() => ({ count: 0 }));
vi.mock("pg", () => {
  class Pool {
    constructor() {
      created.count += 1;
    }
  }
  // The driver exports the class under its own name.
  return { default: Object.fromEntries([["Pool", Pool]]) };
});

import { closePools, withActor } from "./index.ts";

describe("closePools before any use", () => {
  it("opens no pool, now or afterwards", async () => {
    vi.stubEnv("APP_DATABASE_URL", "postgres://app:invented@db.invalid:5432/ductura");
    await closePools();
    await expect(withActor("invented-token", async () => undefined)).rejects.toThrow(
      /database pools are closed/u,
    );
    expect(created.count).toBe(0);
  });
});

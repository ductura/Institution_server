// The eight sync states of Ductus src/domain/sync/states.ts (220b5db), the only
// part of it ported for DAN-851-2a2 (Ductus#1836 c.6942854664).
import { describe, expect, it } from "vitest";

import * as sync from "./index.ts";
import { SYNC_STATES } from "./states.ts";

describe("SYNC_STATES", () => {
  it("is the eight states, frozen, and the area exports only it", () => {
    expect(SYNC_STATES).toEqual([
      "EDITING",
      "SAVING_LOCAL",
      "LOCAL_DURABLE",
      "SYNCING",
      "SYNCED",
      "CONFLICT",
      "ERROR",
      "RECOVERY_REQUIRED",
    ]);
    expect(Object.isFrozen(SYNC_STATES)).toBe(true);
    expect(Object.keys(sync)).toEqual(["SYNC_STATES"]);
  });
});

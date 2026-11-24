// SRV-MENTOR-3B: the orphan work data job over an in-memory port. That the
// schedule runs it only as a dry run until its name is on EXECUTE_ALLOWED is
// tested in server/database/queue/schedule/orphan-work-data.test.ts; this
// area does not import the queue folder (registry-boundary.test.ts).
import { describe, expect, it, vi } from "vitest";

import {
  purgeOrphanWorkDataJob,
  PURGE_ORPHAN_WORK_DATA_EVERY_MS,
  PURGE_ORPHAN_WORK_DATA_JOB,
  registerPurgeOrphanWorkData,
  type PurgeOrphanWorkDataJob,
} from "./purge-orphan-work-data.ts";

function port() {
  return { purge: vi.fn(async () => 4), count: vi.fn(async () => 6) };
}

describe("purge_orphan_work_data", () => {
  it("runs once a day under its own name and asks to execute", () => {
    const definition = purgeOrphanWorkDataJob(port());
    expect(definition).toMatchObject({
      name: "purge_orphan_work_data",
      mode: "execute",
      everyMs: 86_400_000,
    });
    expect(PURGE_ORPHAN_WORK_DATA_JOB).toBe("purge_orphan_work_data");
    expect(PURGE_ORPHAN_WORK_DATA_EVERY_MS).toBe(86_400_000);
    expect(Object.isFrozen(definition)).toBe(true);
  });

  it("executes through purge and counts through count", async () => {
    const p = port();
    const definition = purgeOrphanWorkDataJob(p);
    const signal = new AbortController().signal;
    const slot = new Date("2026-12-07T00:00:00.000Z");
    expect(await definition.execute(slot, signal)).toBe(4);
    expect(await definition.candidates(slot, signal)).toBe(6);
    expect(p.purge).toHaveBeenCalledTimes(1);
    expect(p.count).toHaveBeenCalledTimes(1);
  });

  it("registers itself once through the function the schedule passes", () => {
    const registered: PurgeOrphanWorkDataJob[] = [];
    registerPurgeOrphanWorkData((definition) => registered.push(definition), port());
    expect(registered).toHaveLength(1);
    expect(registered[0]?.name).toBe(PURGE_ORPHAN_WORK_DATA_JOB);
  });
});

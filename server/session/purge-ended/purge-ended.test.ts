// SRV-1303: the first scheduled job over an in-memory port. The schedule's
// own rules (the execute gate, one slot once) are tested in
// server/database/queue/schedule/schedule.test.ts; this area does not import
// the queue folder (server/database/registry-boundary.test.ts).
import { describe, expect, it, vi } from "vitest";

import {
  purgeCut,
  purgeEndedSessionsJob,
  PURGE_ENDED_SESSIONS_EVERY_MS,
  PURGE_ENDED_SESSIONS_JOB,
  registerPurgeEndedSessions,
  SESSION_RETENTION_MS,
  type EndedSessionsPort,
  type PurgeEndedSessionsJob,
} from "./purge-ended.ts";

const DAY = 86_400_000;
const SLOT = new Date("2026-12-07T00:00:00.000Z");

function port(): EndedSessionsPort & {
  purge: ReturnType<typeof vi.fn>;
  count: ReturnType<typeof vi.fn>;
} {
  return { purge: vi.fn(async () => 5), count: vi.fn(async () => 7) };
}

describe("purge_ended_sessions", () => {
  it("keeps ended sessions 30 days (D-200 P2) and runs once a day", () => {
    expect(SESSION_RETENTION_MS).toBe(30 * DAY);
    expect(PURGE_ENDED_SESSIONS_EVERY_MS).toBe(DAY);
    expect(purgeCut(SLOT)).toEqual(new Date("2026-11-07T00:00:00.000Z"));
  });

  it("is an execute job of the allowed name", () => {
    const definition = purgeEndedSessionsJob(port());
    expect(definition).toMatchObject({
      name: "purge_ended_sessions",
      mode: "execute",
      everyMs: DAY,
    });
    expect(PURGE_ENDED_SESSIONS_JOB).toBe("purge_ended_sessions");
    expect(Object.isFrozen(definition)).toBe(true);
  });

  it("executes with the cut of the slot, and counts with the same cut", async () => {
    const p = port();
    const definition = purgeEndedSessionsJob(p);
    const signal = new AbortController().signal;
    expect(await definition.execute(SLOT, signal)).toBe(5);
    expect(await definition.candidates(SLOT, signal)).toBe(7);
    expect(p.purge).toHaveBeenCalledWith(new Date("2026-11-07T00:00:00.000Z"));
    expect(p.count).toHaveBeenCalledWith(new Date("2026-11-07T00:00:00.000Z"));
  });

  it("registers itself, once, through the function the schedule passes", () => {
    const registered: PurgeEndedSessionsJob[] = [];
    registerPurgeEndedSessions((definition) => registered.push(definition), port());
    expect(registered).toHaveLength(1);
    expect(registered[0]).toMatchObject({ name: PURGE_ENDED_SESSIONS_JOB, mode: "execute" });
  });
});

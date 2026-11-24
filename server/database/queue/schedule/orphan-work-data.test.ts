// SRV-MENTOR-3B: the retention adapter of the orphan work data over a
// scripted connection: the SQL each call sends, the dry run's rollback, the
// bigint count and the closed codes for errors, and (SRV-MENTOR-3C) that the
// schedule now executes it. The function itself is tested
// on PostgreSQL in db/main/tests/239-retention-orphan-work-data.sql.
import { describe, expect, it } from "vitest";

import type { RetentionClient } from "./ended-sessions.ts";
import { createOrphanWorkDataPurge } from "./orphan-work-data.ts";
import {
  createJobSchedule,
  effectiveMode,
  ScheduledJobError,
  type ScheduledRun,
  type ScheduleQueue,
} from "./schedule.ts";

const PURGE = "SELECT collaboration.purge_orphan_work_data() AS deleted";

function scripted(
  answer: (text: string) => { rows: Record<string, unknown>[] } | Error,
): RetentionClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async query(text) {
      calls.push(text);
      const result = answer(text);
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

/** A queue that takes each slot once and runs the handler on it. */
function scheduleQueue(): ScheduleQueue {
  const waiting: Array<{ name: string; body: Record<string, string> }> = [];
  return {
    async enqueue(name, input) {
      waiting.push({ name, body: input as Record<string, string> });
      return "queued";
    },
    async runOnce(name, handler) {
      const index = waiting.findIndex((j) => j.name === name);
      if (index < 0) return { status: "idle" };
      const [job] = waiting.splice(index, 1);
      const result = await handler(job!.body, new AbortController().signal);
      return result.ok ? { status: "completed" } : { status: "failed", code: result.code };
    },
  };
}

describe("createOrphanWorkDataPurge", () => {
  it("purges through the retention function and reads the bigint count", async () => {
    const client = scripted(() => ({ rows: [{ deleted: "5" }] }));
    expect(await createOrphanWorkDataPurge(client).purge()).toBe(5);
    expect(client.calls).toEqual([PURGE]);
  });

  it("counts with the same call inside a transaction it always rolls back", async () => {
    const client = scripted((text) => (text === PURGE ? { rows: [{ deleted: 3 }] } : { rows: [] }));
    expect(await createOrphanWorkDataPurge(client).count()).toBe(3);
    expect(client.calls).toEqual(["BEGIN", PURGE, "ROLLBACK"]);
  });

  it("rolls the count back when the call fails, and reports a closed code", async () => {
    const client = scripted((text) =>
      text === PURGE
        ? Object.assign(new Error("synthetic database text"), { code: "42501" })
        : { rows: [] },
    );
    await expect(createOrphanWorkDataPurge(client).count()).rejects.toEqual(
      new ScheduledJobError("purge_unavailable"),
    );
    expect(client.calls.at(-1)).toBe("ROLLBACK");
  });

  it.each([
    ["no row", []],
    ["two rows", [{ deleted: 1 }, { deleted: 1 }]],
    ["a negative count", [{ deleted: -1 }]],
    ["a fraction", [{ deleted: 1.5 }]],
    ["a text that is no number", [{ deleted: "5 rows" }]],
    ["a count past the safe integers", [{ deleted: "90071992547409930" }]],
    ["null", [{ deleted: null }]],
  ])("refuses %s as invalid_count", async (_name, rows) => {
    const client = scripted(() => ({ rows }));
    await expect(createOrphanWorkDataPurge(client).purge()).rejects.toEqual(
      new ScheduledJobError("invalid_count"),
    );
  });

  it("gives no count when the rollback fails", async () => {
    const client = scripted((text) =>
      text === "ROLLBACK" ? new Error("synthetic") : { rows: [{ deleted: 2 }] },
    );
    await expect(createOrphanWorkDataPurge(client).count()).rejects.toEqual(
      new ScheduledJobError("purge_unavailable"),
    );
  });

  it("gives no count when the transaction cannot start", async () => {
    const client = scripted((text) => (text === "BEGIN" ? new Error("synthetic") : { rows: [] }));
    await expect(createOrphanWorkDataPurge(client).count()).rejects.toEqual(
      new ScheduledJobError("purge_unavailable"),
    );
    expect(client.calls).toEqual(["BEGIN"]);
  });

  it("executes on the schedule (owner decision of 24 Nov 2026), and only when it asks to", () => {
    expect(effectiveMode({ name: "purge_orphan_work_data", mode: "execute" })).toBe("execute");
    expect(effectiveMode({ name: "purge_orphan_work_data", mode: "dry-run" })).toBe("dry-run");
  });

  it("on the schedule, execute purges through the retention function and records its count", async () => {
    const client = scripted(() => ({ rows: [{ deleted: "7" }] }));
    const port = createOrphanWorkDataPurge(client);
    const runs: ScheduledRun[] = [];
    const schedule = createJobSchedule({ onRun: (run) => runs.push(run) });
    schedule.registerScheduledJob({
      name: "purge_orphan_work_data",
      mode: "execute",
      everyMs: 86_400_000,
      candidates: () => port.count(),
      execute: () => port.purge(),
    });

    const ticks = await schedule.run(scheduleQueue(), new Date("2026-12-07T10:15:00.000Z"));

    expect(client.calls).toEqual([PURGE]);
    expect(ticks).toEqual([
      { name: "purge_orphan_work_data", enqueued: "queued", outcome: { status: "completed" } },
    ]);
    expect(runs).toEqual([
      {
        name: "purge_orphan_work_data",
        mode: "execute",
        slot: "2026-12-07T00:00:00.000Z",
        count: 7,
      },
    ]);
  });

  it("on the schedule, a failed purge is the job's closed code, never database text", async () => {
    const client = scripted(() => new Error("synthetic database text"));
    const port = createOrphanWorkDataPurge(client);
    const schedule = createJobSchedule();
    schedule.registerScheduledJob({
      name: "purge_orphan_work_data",
      mode: "execute",
      everyMs: 86_400_000,
      candidates: () => port.count(),
      execute: () => port.purge(),
    });

    const ticks = await schedule.run(scheduleQueue(), new Date("2026-12-07T10:15:00.000Z"));

    expect(client.calls).toEqual([PURGE]);
    expect(ticks[0]?.outcome).toEqual({ status: "failed", code: "purge_unavailable" });
  });
});

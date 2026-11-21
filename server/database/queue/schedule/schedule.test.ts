// SRV-1303 (M10.0-S2): the schedule over an in-memory queue with the same
// singleton rule as the pg-boss queue (one waiting or running job per subject)
// and the same body guard (parseJobBody). The sessions are invented rows with
// an end time only. Covers acceptance (3), a job without the execute mark
// deletes nothing, and (4), a second run of one slot does not delete twice.
import { describe, expect, it, vi } from "vitest";

import { parseJobBody } from "../../../domain/index.ts";
import type { JobHandler, JobOutcome } from "../index.ts";

import {
  createJobSchedule,
  effectiveMode,
  EXECUTE_ALLOWED,
  ScheduledJobError,
  ScheduleError,
  type ScheduledJobDefinition,
  type ScheduledRun,
  type ScheduleQueue,
} from "./schedule.ts";
import { slotId } from "./slot.ts";

const DAY = 86_400_000;
const NOW = new Date("2026-12-07T10:15:00.000Z");
const MIDNIGHT = Date.parse("2026-12-07T00:00:00.000Z");

type Job = { id: number; name: string; body: Record<string, string>; state: "created" | "done" };

function memoryQueue(): ScheduleQueue & { jobs: Job[] } {
  const jobs: Job[] = [];
  let next = 1;
  return {
    jobs,
    async enqueue(name, input) {
      const parsed = parseJobBody(input, ["slotId"]);
      if (!parsed.ok) return "rejected";
      const key = parsed.body["slotId"];
      if (jobs.some((j) => j.name === name && j.state === "created" && j.body["slotId"] === key))
        return "duplicate";
      jobs.push({ id: next++, name, body: { ...parsed.body }, state: "created" });
      return "queued";
    },
    async runOnce(name, handler: JobHandler): Promise<JobOutcome> {
      const job = jobs.find((j) => j.name === name && j.state === "created");
      if (job === undefined) return { status: "idle" };
      const parsed = parseJobBody(job.body, ["slotId"]);
      if (!parsed.ok) return { status: "failed", code: "invalid_body" };
      const result = await handler(parsed.body, new AbortController().signal);
      job.state = "done";
      return result.ok ? { status: "completed" } : { status: "failed", code: result.code };
    },
  };
}

/** Invented sessions: an end time in milliseconds, or null while live. */
function sessions(ends: Array<number | null>) {
  const rows = ends.map((end, i) => ({ id: i, end }));
  const ended = (before: Date) => rows.filter((r) => r.end !== null && r.end < before.getTime());
  return {
    rows,
    count: vi.fn(async (before: Date) => ended(before).length),
    purge: vi.fn(async (before: Date) => {
      const gone = new Set(ended(before).map((r) => r.id));
      for (let i = rows.length - 1; i >= 0; i -= 1) if (gone.has(rows[i]!.id)) rows.splice(i, 1);
      return gone.size;
    }),
  };
}

function job(
  name: string,
  mode: unknown,
  store: ReturnType<typeof sessions>,
): ScheduledJobDefinition {
  return {
    name,
    mode: mode as ScheduledJobDefinition["mode"],
    everyMs: DAY,
    candidates: (slot) => store.count(new Date(slot.getTime() - 30 * DAY)),
    execute: (slot) => store.purge(new Date(slot.getTime() - 30 * DAY)),
  };
}

const OLD = MIDNIGHT - 31 * DAY;
const RECENT = MIDNIGHT - 29 * DAY;

describe("the execute gate (acceptance 3)", () => {
  it("before D-30 only purge_ended_sessions may execute", () => {
    expect(EXECUTE_ALLOWED).toEqual(["purge_ended_sessions"]);
    expect(Object.isFrozen(EXECUTE_ALLOWED)).toBe(true);
    expect(effectiveMode({ name: "purge_ended_sessions", mode: "execute" })).toBe("execute");
    expect(effectiveMode({ name: "purge_ended_sessions", mode: "dry-run" })).toBe("dry-run");
    expect(effectiveMode({ name: "daily_root", mode: "execute" })).toBe("dry-run");
  });

  it.each([
    ["a dry-run job on the allowed list", "purge_ended_sessions", "dry-run"],
    ["a job without a mode", "purge_ended_sessions", undefined],
    ["a job whose mode is another spelling", "purge_ended_sessions", "EXECUTE"],
    ["a job whose mode is true", "purge_ended_sessions", true],
    ["an execute job that is not on the allowed list", "stale_drafts", "execute"],
  ])("%s never reaches execute and deletes nothing", async (_label, name, mode) => {
    const store = sessions([OLD, OLD, RECENT, null]);
    const runs: ScheduledRun[] = [];
    const schedule = createJobSchedule({ onRun: (run) => runs.push(run) });
    schedule.registerScheduledJob(job(name, mode, store));
    const queue = memoryQueue();

    const ticks = await schedule.run(queue, NOW);

    expect(store.purge).not.toHaveBeenCalled();
    expect(store.rows).toHaveLength(4);
    expect(store.count).toHaveBeenCalledTimes(1);
    expect(ticks).toEqual([{ name, enqueued: "queued", outcome: { status: "completed" } }]);
    expect(runs).toEqual([{ name, mode: "dry-run", slot: "2026-12-07T00:00:00.000Z", count: 2 }]);
    expect(schedule.modes()).toEqual({ [name]: "dry-run" });
  });

  it("the execute job on the allowed list deletes only what ended before the cut", async () => {
    const store = sessions([OLD, OLD, RECENT, null]);
    const runs: ScheduledRun[] = [];
    const schedule = createJobSchedule({ onRun: (run) => runs.push(run) });
    schedule.registerScheduledJob(job("purge_ended_sessions", "execute", store));

    await schedule.run(memoryQueue(), NOW);

    expect(store.count).not.toHaveBeenCalled();
    expect(store.purge).toHaveBeenCalledWith(new Date(MIDNIGHT - 30 * DAY));
    expect(store.rows.map((r) => r.end)).toEqual([RECENT, null]);
    expect(runs).toEqual([
      { name: "purge_ended_sessions", mode: "execute", slot: "2026-12-07T00:00:00.000Z", count: 2 },
    ]);
  });
});

describe("one slot runs once (acceptance 4)", () => {
  it("a second run in the same slot neither queues nor deletes again", async () => {
    const store = sessions([OLD, OLD, RECENT]);
    const schedule = createJobSchedule();
    schedule.registerScheduledJob(job("purge_ended_sessions", "execute", store));
    const queue = memoryQueue();

    await schedule.run(queue, NOW);
    const second = await schedule.run(queue, new Date(NOW.getTime() + 3_600_000));

    expect(second).toEqual([
      { name: "purge_ended_sessions", enqueued: "skipped", outcome: { status: "idle" } },
    ]);
    expect(store.purge).toHaveBeenCalledTimes(1);
    expect(queue.jobs).toHaveLength(1);
  });

  it("the same slot queued twice by two workers is one job; run again after it, it deletes nothing", async () => {
    const store = sessions([OLD, OLD, RECENT]);
    const queue = memoryQueue();
    const counts: number[] = [];
    const workers = [0, 1].map(() => {
      const schedule = createJobSchedule({ onRun: (run) => counts.push(run.count) });
      schedule.registerScheduledJob(job("purge_ended_sessions", "execute", store));
      return schedule;
    });

    const body = { slotId: slotId("purge_ended_sessions", MIDNIGHT) };
    expect(await queue.enqueue("purge_ended_sessions", body)).toBe("queued");
    expect(await queue.enqueue("purge_ended_sessions", body)).toBe("duplicate");
    await workers[0]!.run(queue, NOW);
    // Another process that has not queued this slot yet queues it again after it ran.
    const late = await workers[1]!.run(queue, NOW);

    expect(late[0]).toEqual({
      name: "purge_ended_sessions",
      enqueued: "queued",
      outcome: { status: "completed" },
    });
    expect(counts).toEqual([2, 0]);
    expect(store.purge.mock.calls.map(([cut]) => cut)).toEqual([
      new Date(MIDNIGHT - 30 * DAY),
      new Date(MIDNIGHT - 30 * DAY),
    ]);
    expect(store.rows.map((r) => r.end)).toEqual([RECENT]);
  });

  it("the cut is the slot's start, not the clock when the job runs", async () => {
    const store = sessions([MIDNIGHT - 30 * DAY + 60_000]);
    const schedule = createJobSchedule();
    schedule.registerScheduledJob(job("purge_ended_sessions", "execute", store));
    // Ten hours into the slot: the session ended one minute after the slot's cut, so it stays.
    await schedule.run(memoryQueue(), NOW);
    expect(store.rows).toHaveLength(1);
  });

  it("the next slot is queued and run", async () => {
    const store = sessions([OLD]);
    const schedule = createJobSchedule();
    schedule.registerScheduledJob(job("purge_ended_sessions", "execute", store));
    const queue = memoryQueue();
    await schedule.run(queue, NOW);
    const next = await schedule.run(queue, new Date(NOW.getTime() + DAY));
    expect(next[0]?.enqueued).toBe("queued");
    expect(queue.jobs.map((j) => j.body["slotId"])).toEqual([
      slotId("purge_ended_sessions", MIDNIGHT),
      slotId("purge_ended_sessions", MIDNIGHT + DAY),
    ]);
  });
});

describe("the handler", () => {
  async function runBody(body: Record<string, string>, definition?: ScheduledJobDefinition) {
    const store = sessions([OLD]);
    const schedule = createJobSchedule();
    schedule.registerScheduledJob(definition ?? job("purge_ended_sessions", "execute", store));
    const queue = memoryQueue();
    // A body queued by another writer of the table, before this process queues its own.
    queue.jobs.push({ id: 0, name: "purge_ended_sessions", body, state: "created" });
    const [tick] = await schedule.run(queue, NOW);
    return { tick, store };
  }

  it("refuses a slot id of another job", async () => {
    const { tick, store } = await runBody({ slotId: slotId("daily_root", MIDNIGHT) });
    expect(tick?.outcome).toEqual({ status: "failed", code: "invalid_slot" });
    expect(store.purge).not.toHaveBeenCalled();
  });

  it("refuses a uuid that is no slot id", async () => {
    const { tick } = await runBody({ slotId: "00000000-0000-4000-8000-000000000001" });
    expect(tick?.outcome).toEqual({ status: "failed", code: "invalid_slot" });
  });

  it("refuses a slot that has not started", async () => {
    const { tick, store } = await runBody({
      slotId: slotId("purge_ended_sessions", MIDNIGHT + DAY),
    });
    expect(tick?.outcome).toEqual({ status: "failed", code: "slot_in_future" });
    expect(store.purge).not.toHaveBeenCalled();
  });

  it("stores the closed code of the port, and job_threw for anything else", async () => {
    const coded = await runBody(
      { slotId: slotId("purge_ended_sessions", MIDNIGHT) },
      {
        ...job("purge_ended_sessions", "execute", sessions([])),
        execute: async () => {
          throw new ScheduledJobError("invalid_cut");
        },
      },
    );
    expect(coded.tick?.outcome).toEqual({ status: "failed", code: "invalid_cut" });
    const text = await runBody(
      { slotId: slotId("purge_ended_sessions", MIDNIGHT) },
      {
        ...job("purge_ended_sessions", "execute", sessions([])),
        execute: async () => {
          throw new Error("synthetic text that must not be stored");
        },
      },
    );
    expect(text.tick?.outcome).toEqual({ status: "failed", code: "job_threw" });
  });

  it.each([[-1], [1.5], [Number.NaN], ["2"], [null]])("refuses a count of %s", async (count) => {
    const { tick } = await runBody(
      { slotId: slotId("purge_ended_sessions", MIDNIGHT) },
      {
        ...job("purge_ended_sessions", "execute", sessions([])),
        execute: async () => count as number,
      },
    );
    expect(tick?.outcome).toEqual({ status: "failed", code: "invalid_count" });
  });
});

describe("registration", () => {
  const store = sessions([]);

  it("gives the queue one definition per job, with the slot id as the only field", () => {
    const schedule = createJobSchedule();
    schedule.registerScheduledJob(job("purge_ended_sessions", "execute", store));
    schedule.registerScheduledJob(job("daily_root", "dry-run", store));
    expect(schedule.queueDefinitions()).toEqual([
      { name: "purge_ended_sessions", fields: ["slotId"], subject: "slotId" },
      { name: "daily_root", fields: ["slotId"], subject: "slotId" },
    ]);
  });

  it("is sealed once the queue has its definitions", () => {
    const schedule = createJobSchedule();
    schedule.registerScheduledJob(job("purge_ended_sessions", "execute", store));
    schedule.queueDefinitions();
    expect(() => schedule.registerScheduledJob(job("daily_root", "dry-run", store))).toThrow(
      new ScheduleError("schedule_sealed"),
    );
  });

  it("refuses an empty schedule and a second job of one name", async () => {
    expect(() => createJobSchedule().queueDefinitions()).toThrow(
      new ScheduleError("schedule_empty"),
    );
    const schedule = createJobSchedule();
    schedule.registerScheduledJob(job("purge_ended_sessions", "execute", store));
    expect(() =>
      schedule.registerScheduledJob(job("purge_ended_sessions", "dry-run", store)),
    ).toThrow(new ScheduleError("definition_duplicate"));
  });

  it.each([
    ["not an object", null],
    ["a queue name with upper case", { ...job("Purge", "execute", store) }],
    [
      "a slot under a minute",
      { ...job("purge_ended_sessions", "execute", store), everyMs: 59_999 },
    ],
    [
      "a slot that is not whole minutes",
      { ...job("purge_ended_sessions", "execute", store), everyMs: 90_500 },
    ],
    ["a slot over a week", { ...job("purge_ended_sessions", "execute", store), everyMs: 8 * DAY }],
    ["no execute", { ...job("purge_ended_sessions", "execute", store), execute: undefined }],
    ["no candidates", { ...job("purge_ended_sessions", "execute", store), candidates: 1 }],
  ])("refuses %s", (_label, definition) => {
    expect(() =>
      createJobSchedule().registerScheduledJob(definition as ScheduledJobDefinition),
    ).toThrow(new ScheduleError("definition_invalid"));
  });

  it("reads the definition once: a getter that changes the mode later has no effect", async () => {
    const store2 = sessions([OLD]);
    let reads = 0;
    const definition = {
      ...job("stale_drafts", "dry-run", store2),
      get mode() {
        reads += 1;
        return reads === 1 ? "dry-run" : "execute";
      },
    };
    const schedule = createJobSchedule();
    schedule.registerScheduledJob(definition as ScheduledJobDefinition);
    await schedule.run(memoryQueue(), NOW);
    expect(reads).toBe(1);
    expect(store2.purge).not.toHaveBeenCalled();
  });
});

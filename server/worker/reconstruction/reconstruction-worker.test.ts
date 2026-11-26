// F4-PM2-R02 (M3.3, B-12): the worker is the caller `recordDueCheckpoints`
// lacked: a pass hands every due package to the recorder (which writes the
// checkpoints, package-pass.test.ts) and writes one log line of counts. Every
// package and institution is invented.
import { describe, expect, it, vi } from "vitest";

import {
  type DuePackagesResult,
  type PackageCheckpointRecorder,
  type PackagePassOutcome,
} from "../../evidence/index.ts";
import { createLogger, type LogLevel } from "../../log/index.ts";

import {
  createReconstructionWorker,
  RECONSTRUCTION_FAILED_EVENT,
  RECONSTRUCTION_PASS_EVENT,
  type ReconstructionWorkerDeps,
} from "./index.ts";

const INSTITUTION = "00000000-0000-4000-8000-0000000000f1";

function captureLog() {
  const lines: { level: LogLevel; record: Record<string, unknown> }[] = [];
  const log = createLogger((level, line) => {
    lines.push({ level, record: JSON.parse(line) as Record<string, unknown> });
  });
  return { log, lines };
}

/** A manual clock for the loop: timers run only when the test says so. */
function manualTimers() {
  const pending: { run: () => void; ms: number }[] = [];
  return {
    pending,
    timers: {
      setTimeout: (run: () => void, ms: number) => {
        const entry = { run, ms };
        pending.push(entry);
        return entry;
      },
      clearTimeout: (handle: unknown) => {
        const at = pending.indexOf(handle as (typeof pending)[number]);
        if (at >= 0) pending.splice(at, 1);
      },
    },
  };
}

function listOf(ids: string[]): ReconstructionWorkerDeps["source"] {
  return {
    async listDue({ afterPackageId, limit }): Promise<DuePackagesResult> {
      const rest = ids.filter((id) => afterPackageId === null || id > afterPackageId);
      return {
        status: "found",
        packages: rest.slice(0, limit).map((evidencePackageId) => ({
          evidencePackageId,
          institutionId: INSTITUTION,
          segmentCount: 60,
        })),
      };
    },
  };
}

describe("the reconstruction worker's pass", () => {
  it("hands every due package to the recorder and counts the outcomes", async () => {
    const outcomes: Record<string, PackagePassOutcome> = {
      "paket-a": { status: "recorded", written: 2 },
      "paket-b": { status: "current" },
      "paket-c": { status: "skipped", reason: "gap" },
      "paket-d": { status: "unavailable", reason: "storage_failed" },
    };
    const asked: string[] = [];
    const recorder: PackageCheckpointRecorder = {
      async recordPackage({ evidencePackageId, institutionId }) {
        expect(institutionId).toBe(INSTITUTION);
        asked.push(evidencePackageId);
        return outcomes[evidencePackageId]!;
      },
    };
    const { log, lines } = captureLog();
    const worker = createReconstructionWorker({
      source: listOf(Object.keys(outcomes)),
      recorder,
      log,
      config: { pageSize: 3 },
    });
    expect(await worker.runPass()).toEqual({
      status: "completed",
      more: false,
      packages: 4,
      recorded: 1,
      checkpointsWritten: 2,
      current: 1,
      skipped: 1,
      unavailable: 1,
    });
    expect(asked).toEqual(["paket-a", "paket-b", "paket-c", "paket-d"]);
    // One line per pass, counts only, a warning because a package did not answer.
    expect(lines).toHaveLength(1);
    expect(lines[0]!.level).toBe("warn");
    expect(lines[0]!.record).toMatchObject({
      event: RECONSTRUCTION_PASS_EVENT,
      fields: { packages: 4, checkpointsWritten: 2 },
    });
    expect(JSON.stringify(lines)).not.toMatch(/paket-|00000000-0000/u);
  });

  it("stops at maxPackages and leaves the rest to the next pass", async () => {
    const recorder: PackageCheckpointRecorder = {
      recordPackage: async () => ({ status: "current" }),
    };
    const { log } = captureLog();
    const worker = createReconstructionWorker({
      source: listOf(["paket-a", "paket-b", "paket-c", "paket-d", "paket-e"]),
      recorder,
      log,
      config: { pageSize: 2, maxPackages: 4 },
    });
    expect(await worker.runPass()).toMatchObject({ packages: 4, more: true, status: "completed" });
  });

  it("stops without a verdict when the list does not answer, and survives a recorder that throws", async () => {
    const { log, lines } = captureLog();
    const down = createReconstructionWorker({
      source: { listDue: async () => ({ status: "unavailable", reason: "source_failed" }) },
      recorder: { recordPackage: vi.fn() },
      log,
    });
    expect(await down.runPass()).toMatchObject({ status: "stopped", packages: 0 });
    expect(lines.at(-1)!.level).toBe("warn");

    const throwing = createReconstructionWorker({
      source: listOf(["paket-a", "paket-b"]),
      recorder: {
        recordPackage: async ({ evidencePackageId }) => {
          if (evidencePackageId === "paket-a") throw new Error("pao");
          return { status: "recorded", written: 1 };
        },
      },
      log,
    });
    expect(await throwing.runPass()).toMatchObject({ unavailable: 1, recorded: 1, packages: 2 });
  });

  it("logs a failure line, not an exception, for a programming error", async () => {
    const { log, lines } = captureLog();
    const worker = createReconstructionWorker({
      source: {
        listDue: () => {
          throw new Error("x");
        },
      },
      recorder: { recordPackage: vi.fn() },
      log,
    });
    // A throwing `listDue` is a value of the sweep, not a crash.
    expect(await worker.runPass()).toMatchObject({ status: "stopped" });
    const broken = createReconstructionWorker({
      source: { listDue: async () => ({ status: "found", packages: null as never }) },
      recorder: { recordPackage: vi.fn() },
      log,
    });
    expect(await broken.runPass()).toBeNull();
    expect(lines.at(-1)).toMatchObject({
      level: "error",
      record: { event: RECONSTRUCTION_FAILED_EVENT },
    });
  });

  it("refuses a configuration or a port it cannot run with", () => {
    const base = { source: listOf([]), recorder: { recordPackage: vi.fn() }, log: vi.fn() };
    for (const config of [
      { intervalMs: 0 },
      { checkpointInterval: 0 },
      { pageSize: 501 },
      { maxPackages: 0 },
    ]) {
      expect(() => createReconstructionWorker({ ...base, config })).toThrow(RangeError);
    }
    expect(() => createReconstructionWorker({ ...base, log: undefined as never })).toThrow(
      TypeError,
    );
    expect(() => createReconstructionWorker({ ...base, source: undefined as never })).toThrow(
      TypeError,
    );
    expect(() => createReconstructionWorker({ ...base, recorder: undefined as never })).toThrow(
      TypeError,
    );
  });
});

describe("the reconstruction worker's loop", () => {
  it("runs a pass at start, then every intervalMs, and none after stop", async () => {
    const { pending, timers } = manualTimers();
    const passes = vi.fn(async () => ({ status: "current" }) as const);
    const worker = createReconstructionWorker({
      source: listOf(["paket-a"]),
      recorder: { recordPackage: passes },
      log: captureLog().log,
      timers,
      config: { intervalMs: 7_000 },
    });
    worker.start();
    worker.start(); // a second start is no second loop
    expect(pending.map((t) => t.ms)).toEqual([0]);
    pending.shift()!.run();
    await vi.waitFor(() => expect(pending.map((t) => t.ms)).toEqual([7_000]));
    expect(passes).toHaveBeenCalledTimes(1);
    pending.shift()!.run();
    await vi.waitFor(() => expect(passes).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    await worker.stop();
    expect(pending).toHaveLength(0);
    expect(await worker.runPass()).toBeNull();
    worker.start();
    expect(pending).toHaveLength(0);
  });

  it("waits for the running pass on stop, starts no package after it and joins a second request", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const recordPackage = vi.fn(async () => ({ status: "current" }) as const);
    const worker = createReconstructionWorker({
      source: {
        async listDue(input) {
          await gate;
          return listOf(["paket-a", "paket-b"]).listDue(input);
        },
      },
      recorder: { recordPackage },
      log: captureLog().log,
    });
    const first = worker.runPass();
    expect(worker.runPass()).toBe(first);
    let stopped = false;
    const stopping = worker.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(stopped).toBe(true);
    expect(recordPackage).not.toHaveBeenCalled();
  });
});

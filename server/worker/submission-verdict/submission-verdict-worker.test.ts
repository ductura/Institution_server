import { describe, expect, it, vi } from "vitest";

import { InMemoryEvidencePayloadStore } from "../../external/storage/in-memory-evidence-payload-store.ts";

import {
  createSubmissionVerdictWorker,
  SUBMISSION_VERDICT_FAILED_EVENT,
  SUBMISSION_VERDICT_PASS_EVENT,
} from "./index.ts";

const DOMAIN = "00000000-0000-4000-8000-0000000000d1";

function make(rows: unknown[] = [], options: { fail?: boolean; intervalMs?: number } = {}) {
  const log = vi.fn();
  const timers = { handle: null as null | (() => void), cleared: 0 };
  const worker = createSubmissionVerdictWorker({
    verdict: {
      query: async () => {
        if (options.fail) throw new Error("connection reset: secret detail");
        return { rows };
      },
      evidenceDomainId: DOMAIN,
      payloads: new InMemoryEvidencePayloadStore(),
      readKeys: async () => ({ status: "ok", keys: [] }),
    },
    log,
    ...(options.intervalMs === undefined ? {} : { intervalMs: options.intervalMs }),
    timers: {
      setTimeout: (run) => ((timers.handle = run), "t"),
      clearTimeout: () => void (timers.cleared += 1),
    },
  });
  return { worker, log, timers };
}

describe("the submission verdict worker (F4-PM2-R01)", () => {
  it("a pass writes one log line with counts only", async () => {
    const { worker, log } = make([]);
    expect(await worker.runPass()).toEqual({ listed: 0, verified: 0, mismatch: 0, unavailable: 0 });
    expect(log).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith("info", SUBMISSION_VERDICT_PASS_EVENT, {
      listed: 0,
      verified: 0,
      mismatch: 0,
      unavailable: 0,
    });
  });

  it("a list that fails is a quiet pass, never an exception or a leaked message", async () => {
    const { worker, log } = make([], { fail: true });
    expect(await worker.runPass()).toEqual({ listed: 0, verified: 0, mismatch: 0, unavailable: 0 });
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret");
  });

  it("a configuration error is an error line and a null pass", async () => {
    const log = vi.fn();
    const worker = createSubmissionVerdictWorker({
      verdict: {
        query: async () => ({ rows: [] }),
        evidenceDomainId: "nije-uuid",
        payloads: new InMemoryEvidencePayloadStore(),
        readKeys: async () => ({ status: "ok", keys: [] }),
      },
      log,
    });
    expect(await worker.runPass()).toBeNull();
    expect(log).toHaveBeenCalledWith("error", SUBMISSION_VERDICT_FAILED_EVENT, {});
  });

  it("start runs a pass at once, then waits the interval; stop ends it and later passes do not run", async () => {
    const { worker, log, timers } = make([], { intervalMs: 5 });
    worker.start();
    worker.start();
    timers.handle?.();
    await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(1));
    await worker.stop();
    expect(timers.cleared).toBeGreaterThanOrEqual(0);
    expect(await worker.runPass()).toBeNull();
    expect(log).toHaveBeenCalledTimes(1);
  });

  it.each([0, -1, 1.5, 3_600_001])("refuses the interval %s", (intervalMs) => {
    expect(() => make([], { intervalMs })).toThrow(RangeError);
  });

  it("refuses a missing log", () => {
    expect(() =>
      createSubmissionVerdictWorker({ log: undefined as never, verdict: {} as never }),
    ).toThrow(TypeError);
  });
});

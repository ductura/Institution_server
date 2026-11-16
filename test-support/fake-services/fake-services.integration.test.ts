// S-1E-c (DAN-837), acceptance: storage, keys and email each pass ok, slow and
// down behind the guard; a slow service never holds a call past the deadline;
// no key, password or address reaches the event. Invented values only.
import { describe, expect, it } from "vitest";

import { guardEmail } from "../../server/external/email/index.ts";
import { guardKeys } from "../../server/external/keys/index.ts";
import { guardStorage } from "../../server/external/storage/index.ts";
import {
  createExternalCaller,
  type ExternalCallEvent,
  type ExternalService,
} from "../../server/metrics/index.ts";
import { createFakeEmail, createFakeKeys, createFakeStorage, type FakeGate } from "./index.ts";

const MODES = ["ok", "slow", "down"] as const;
const POLICY = { timeoutMs: 2000, retries: 1, retryDelayMs: 50, downAfter: 3, downForMs: 10_000 };
const SECRET = "canary-lozinka-x9@primjer.invalid";
const HASH = "a".repeat(64);
const IDS = {
  institutionId: "00000000-0000-4000-8000-000000000001",
  evidencePackageId: "00000000-0000-4000-8000-000000000002",
  segmentHash: HASH,
};

type Case = { gate: FakeGate; run: () => Promise<unknown>; isOk: (v: unknown) => boolean };

function build(service: ExternalService, mode: (typeof MODES)[number]) {
  const events: ExternalCallEvent[] = [];
  const holder: { gate?: FakeGate } = {};
  const caller = createExternalCaller(service, POLICY, {
    now: () => holder.gate?.clock.nowMs() ?? 0,
    sleep: (ms, signal) => (holder.gate as FakeGate).clock.sleep(ms, signal),
    onEvent: (e) => events.push(e),
  });
  let c: Case;
  if (service === "storage") {
    const fake = createFakeStorage({ mode });
    const guarded = guardStorage(fake, caller);
    c = {
      gate: fake.gate,
      run: () => guarded.readImmutable(IDS),
      isOk: (v) => (v as { status: string }).status === "not_found",
    };
  } else if (service === "keys") {
    const fake = createFakeKeys({ mode });
    const guarded = guardKeys(fake, caller);
    c = {
      gate: fake.gate,
      run: () => guarded.sign(new TextEncoder().encode(SECRET)),
      isOk: (v) => (v as { ok: boolean }).ok,
    };
  } else {
    const fake = createFakeEmail({ mode });
    const guarded = guardEmail(fake, caller);
    const message = { to: SECRET, template: "invite", values: { password: SECRET } };
    c = {
      gate: fake.gate,
      run: () => guarded.send(message),
      isOk: (v) => (v as { ok: boolean }).ok,
    };
  }
  holder.gate = c.gate;
  return { ...c, events, caller };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
};

describe.each(["storage", "keys", "email"] as const)("%s behind the guard", (service) => {
  it.each(MODES)("mode %s answers within the deadline", async (mode) => {
    const { gate, run, isOk, events } = build(service, mode);
    const pending = run();
    await flush();
    gate.clock.advance(POLICY.retryDelayMs);
    await flush();
    gate.clock.advance(POLICY.timeoutMs - POLICY.retryDelayMs);
    const answer = await pending;
    expect(isOk(answer)).toBe(mode === "ok");
    expect(events).toHaveLength(1);
    expect(events[0]?.durationMs).toBeLessThanOrEqual(POLICY.timeoutMs);
    expect(events[0]?.outcome).toBe(mode === "ok" ? "ok" : mode === "slow" ? "timeout" : "failed");
    expect(JSON.stringify(events)).not.toContain("canary");
    expect(JSON.stringify(answer)).not.toContain("canary");
  });

  it("stops reaching a service that is down", async () => {
    const { gate, run, caller, events } = build(service, "down");
    for (let i = 0; i < 4; i += 1) {
      const pending = run();
      await flush();
      gate.clock.advance(POLICY.retryDelayMs);
      await pending;
    }
    expect(caller.availability()).toBe("down");
    expect(events.at(-1)?.outcome).toBe("down");
    const before = gate.reached();
    await run();
    expect(gate.reached()).toBe(before);
  });
});

describe("retry only where the operation is idempotent", () => {
  it("sends sign, put and email once, and retries a read once more", async () => {
    for (const service of ["keys", "email"] as const) {
      const { gate, run } = build(service, "down");
      await run();
      expect(gate.reached()).toBe(1);
    }
    const { gate, events } = build("storage", "down");
    const caller = createExternalCaller("storage", POLICY, {
      now: () => gate.clock.nowMs(),
      sleep: (ms, s) => gate.clock.sleep(ms, s),
      onEvent: (e) => events.push(e),
    });
    const fake = createFakeStorage({ mode: "down", clock: gate.clock });
    const guarded = guardStorage(fake, caller);
    await guarded.putImmutable({ ...IDS, canonicalPayload: "{}" });
    expect(fake.gate.reached()).toBe(1);
    const read = guarded.readImmutable(IDS);
    await flush();
    gate.clock.advance(POLICY.retryDelayMs);
    expect(await read).toEqual({ status: "unavailable", reason: "storage_unavailable" });
    expect(fake.gate.reached()).toBe(3);
  });
});

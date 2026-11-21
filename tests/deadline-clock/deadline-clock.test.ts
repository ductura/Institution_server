// SRV-1313 (plan M7.4, DAN-382): the deadline on the server across a change of
// the clock. A wall clock (./clock.ts over @ductura/test-fakes/clock) is set
// forward and back around a deadline and around the summer and winter time
// changes of Europe/Zagreb:
//
//   1. the signed receipt the server hands out reads a click a minute before
//      the deadline as on time and a minute after as late, also after the
//      clock is set back; any other afterDeadline is not a receipt;
//   2. a deadline in the night of a time change means the same instant and
//      the same Zagreb wall time on the server as in the database: the pairs
//      of db/main/tests/185-deadline-clock.sql are read and checked here, in
//      four host zones;
//   3. (the extension per student is the database's: pgTAP 185);
//   4. a deadline reaches the server only as an instant; a Zagreb minute with
//      no zone is refused by every contract that takes one, so the database
//      never resolves the repeated hour itself.
//
// The submission route itself, with the client's clock, is
// client-clock.integration.test.ts. Every value is invented.
import { readFileSync } from "node:fs";

import { Value } from "@sinclair/typebox/value";
import { createFakeClock } from "@ductura/test-fakes/clock";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ROUTES } from "../../server/contracts/index.ts";
import { isSubmissionReceiptPayloadV2 } from "../../server/domain/forensics/index.ts";
import {
  zagrebEpochMs,
  zagrebInstant,
  zagrebLocalMinute,
  zagrebOffset,
} from "../../server/domain/time/index.ts";

// A server clock a test sets forward and back. The fake clock of
// @ductura/test-fakes only moves forward, as a monotonic clock does; a wall
// clock can also be set back (a corrected clock, the end of summer time read
// on a wall). Forward is the fake clock's own advance, back an offset on top.
type WallClock = {
  /** The current time in milliseconds since the epoch. */
  nowMs(): number;
  /** The current time as an instant with six fraction digits, as the receipts write it. */
  nowMicros(): string;
  /** Sets the clock forward by `ms`. */
  forward(ms: number): void;
  /** Sets the clock back by `ms`. */
  back(ms: number): void;
};

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** An instant of the receipts (`…T…:…:….ssssssZ`) for epoch milliseconds. */
function micros(epochMs: number): string {
  return `${new Date(epochMs).toISOString().slice(0, 23)}000Z`;
}

function createWallClock(start: string | number): WallClock {
  const fake = createFakeClock(start);
  let setBack = 0;
  const nowMs = () => fake.nowMs() - setBack;
  return {
    nowMs,
    nowMicros: () => micros(nowMs()),
    forward: (ms) => fake.advance(ms),
    back(ms) {
      if (!Number.isFinite(ms) || ms < 0) throw new RangeError(`back must be >= 0: ${ms}`);
      setBack += ms;
    },
  };
}

const ZONES = ["Europe/Zagreb", "UTC", "America/New_York", "Pacific/Kiritimati"] as const;

afterEach(() => {
  vi.unstubAllEnvs();
});

/** The payload of the contract's own "submitted" vector, as a template. */
const TEMPLATE = (() => {
  const file = new URL(
    "../../server/contracts/vectors/submission.submit.post.json",
    import.meta.url,
  );
  const { vectors } = JSON.parse(readFileSync(file, "utf8")) as {
    vectors: {
      name: string;
      response: { body: { receipt?: { payload: Record<string, unknown> } } };
    }[];
  };
  const payload = vectors.find((v) => v.name === "submitted")?.response.body.receipt?.payload;
  if (payload === undefined) throw new Error("no submitted vector");
  return payload;
})();

/** A receipt payload for a click at `requestedAt` against `dueAt`. */
function receipt(requestedAt: string, dueAt: string, afterDeadline: boolean) {
  return { ...TEMPLATE, requestedAt, dueAt, afterDeadline, signedAt: requestedAt };
}

/** What a receipt says of a click: late, on time, or no receipt for either flag. */
function judged(requestedAt: string, dueAt: string): "late" | "on time" | "none" {
  const late = isSubmissionReceiptPayloadV2(receipt(requestedAt, dueAt, true));
  const onTime = isSubmissionReceiptPayloadV2(receipt(requestedAt, dueAt, false));
  if (late === onTime) return "none";
  return late ? "late" : "on time";
}

/** A teacher's deadline typed as a Zagreb minute, as the epoch milliseconds it means. */
function deadline(local: string): number {
  const at = zagrebEpochMs(local);
  if (at === null) throw new Error(`no instant for ${local}`);
  return at;
}

describe("1. the click against the deadline, with the clock set forward and back", () => {
  const CASES = [
    // The first minute after the skipped hour of 29 March 2026.
    ["spring change", "2026-03-29T03:00", "2026-03-29T01:00:00.000Z"],
    // The first 02:30 of the repeated hour of 25 October 2026.
    ["autumn change, repeated hour", "2026-10-25T02:30", "2026-10-25T00:30:00.000Z"],
    ["an ordinary winter evening", "2026-12-14T23:59", "2026-12-14T22:59:00.000Z"],
  ] as const;

  it.each(CASES)("%s: %s is %s", (_name, local, instant) => {
    expect(new Date(deadline(local)).toISOString()).toBe(instant);
  });

  it.each(CASES)(
    "%s: a minute before is on time, a minute after is late, also set back",
    (_n, local) => {
      const due = deadline(local);
      const dueAt = micros(due);
      const clock = createWallClock(due - MINUTE_MS);
      expect(judged(clock.nowMicros(), dueAt)).toBe("on time");
      clock.forward(MINUTE_MS);
      expect(judged(clock.nowMicros(), dueAt)).toBe("on time");
      clock.forward(1);
      expect(judged(clock.nowMicros(), dueAt)).toBe("late");
      clock.forward(MINUTE_MS - 1);
      const lateClick = clock.nowMicros();
      expect(judged(lateClick, dueAt)).toBe("late");
      // Set back across the deadline: a new click there is on time, and the
      // click already made is still late (its time is in the receipt).
      clock.back(2 * MINUTE_MS);
      expect(judged(clock.nowMicros(), dueAt)).toBe("on time");
      expect(judged(lateClick, dueAt)).toBe("late");
      // And forward again past it.
      clock.forward(2 * MINUTE_MS + 1);
      expect(judged(clock.nowMicros(), dueAt)).toBe("late");
    },
  );

  it("the wall clock in the repeated hour reads earlier than the deadline, yet the click is late", () => {
    const due = deadline("2026-10-25T02:30");
    const clock = createWallClock(due);
    // Forward 45 minutes: the change to winter time sets the wall back an hour.
    clock.forward(45 * MINUTE_MS);
    expect(zagrebLocalMinute(new Date(clock.nowMs()).toISOString())).toBe("2026-10-25T02:15");
    expect(zagrebOffset(new Date(clock.nowMs()).toISOString())).toBe("+01:00");
    expect(judged(clock.nowMicros(), micros(due))).toBe("late");
  });

  it("across the skipped hour two minutes of real time read as an hour and two minutes on the wall", () => {
    const due = deadline("2026-03-29T03:00");
    const clock = createWallClock(due - MINUTE_MS);
    expect(zagrebLocalMinute(new Date(clock.nowMs()).toISOString())).toBe("2026-03-29T01:59");
    expect(judged(clock.nowMicros(), micros(due))).toBe("on time");
    clock.forward(2 * MINUTE_MS);
    expect(zagrebLocalMinute(new Date(clock.nowMs()).toISOString())).toBe("2026-03-29T03:01");
    expect(judged(clock.nowMicros(), micros(due))).toBe("late");
  });

  it("a click before the deadline by the wall clock of the client means nothing: the receipt holds instants", () => {
    // The same wall minute 02:15 twice in the repeated hour, an hour apart.
    const due = micros(deadline("2026-10-25T02:30"));
    expect(judged("2026-10-25T00:15:00.000000Z", due)).toBe("on time");
    expect(judged("2026-10-25T01:15:00.000000Z", due)).toBe("late");
  });
});

/** The Zagreb wall pairs of pgTAP 185, between its zagreb-wall markers. */
const WALL = (() => {
  const sql = readFileSync(
    new URL("../../db/main/tests/185-deadline-clock.sql", import.meta.url),
    "utf8",
  );
  const block = /-- zagreb-wall:begin\n([\s\S]*?)-- zagreb-wall:end/u.exec(sql)?.[1] ?? "";
  return [...block.matchAll(/\('([^']+)', '([^']+)'\)/gu)].map((m) => [m[1]!, m[2]!] as const);
})();

describe("2. the same Zagreb time in the database and on the server", () => {
  it("pgTAP 185 holds the pairs both sides check", () => {
    expect(WALL.length).toBeGreaterThanOrEqual(10);
    const instants = WALL.map(([at]) => at);
    expect(instants).toContain("2026-03-29T01:00:00.000Z");
    expect(instants).toContain("2025-10-26T01:30:00.000Z");
  });

  it.each(ZONES)("with the host in %s, every instant reads the database's wall minute", (zone) => {
    vi.stubEnv("TZ", zone);
    for (const [at, wall] of WALL) expect([at, zagrebLocalMinute(at)]).toEqual([at, wall]);
  });

  it.each(ZONES)(
    "with the host in %s, every wall minute names its instant, the repeated hour its first",
    (zone) => {
      vi.stubEnv("TZ", zone);
      for (const [at, wall] of WALL) {
        const first = zagrebInstant(wall);
        // The second occurrence of a repeated minute is an hour after the first.
        const repeated = first !== null && first !== at;
        expect([at, repeated ? Date.parse(at) - Date.parse(first) : 0]).toEqual([
          at,
          repeated ? HOUR_MS : 0,
        ]);
      }
    },
  );

  it("no deadline in the skipped hour: the minute is refused, never moved", () => {
    for (const local of ["2026-03-29T02:00", "2026-03-29T02:30", "2026-03-29T02:59"]) {
      expect(zagrebInstant(local)).toBeNull();
    }
  });
});

describe("4. a deadline reaches the server only as an instant", () => {
  const bodyOf = (id: string) => {
    const body = ROUTES.find((route) => route.id === id)?.request.body;
    if (body === undefined) throw new Error(`no request body for ${id}`);
    return body;
  };
  const EXTENSION = bodyOf("teacher.deadline-extension.post");
  const extension = (dueAt: string) => ({ scope: "all", dueAt, reasonId: "all" });

  it("an extension takes a UTC instant", () => {
    expect(Value.Check(EXTENSION, extension("2026-10-25T00:30:00.000Z"))).toBe(true);
  });

  it.each([
    "2026-10-25T02:30",
    "2026-10-25T02:30:00",
    "2026-10-25 02:30:00",
    "2026-10-25T02:30:00.000",
    "2026-10-25T02:30:00.000+02:00",
  ])("an extension refuses %s", (dueAt) => {
    expect(Value.Check(EXTENSION, extension(dueAt))).toBe(false);
  });

  it.each([
    "2026-10-25T02:30",
    "2026-10-25T02:30:00",
    "2026-10-25 02:30:00",
    "2026-10-25T02:30:00.000",
  ])("a new assignment version refuses the zone-less deadline %s", (dueAt) => {
    const schema = bodyOf("institution.assignment-versions.post");
    const props = (schema as { properties?: Record<string, unknown> }).properties ?? {};
    const due = props["dueAt"] as Parameters<typeof Value.Check>[0] | undefined;
    expect(due).toBeDefined();
    expect(Value.Check(due!, dueAt)).toBe(false);
    expect(Value.Check(due!, "2026-10-25T02:30:00+02:00")).toBe(true);
    expect(Value.Check(due!, "2026-10-25T02:30:00+01:00")).toBe(true);
  });
});

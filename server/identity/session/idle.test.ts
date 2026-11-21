import { describe, expect, it } from "vitest";

import { SETTINGS_CATALOGUE } from "../../domain/index.ts";

import {
  createIdleTracker,
  DEFAULT_SESSION_IDLE_MINUTES,
  idleLimitMinutes,
  SESSION_IDLE_MAX_MINUTES,
  SESSION_IDLE_MIN_MINUTES,
} from "./idle.ts";

const MINUTE = 60_000;
// Invented tokens in the session token format (43 base64url characters).
const TOKEN_A = "a".repeat(43);
const TOKEN_B = "b".repeat(43);
const TOKEN_C = "c".repeat(43);

function clock(start = 1_000) {
  let at = start;
  return { now: () => at, advance: (ms: number) => (at += ms) };
}

describe("idle limit (SRV-1401, M1.6)", () => {
  it("defaults to 30 minutes", () => {
    expect(DEFAULT_SESSION_IDLE_MINUTES).toBe(30);
    expect(idleLimitMinutes(undefined)).toBe(30);
    expect(idleLimitMinutes(null)).toBe(30);
  });

  it("takes an integer within the catalogue's bounds, else the default", () => {
    expect(idleLimitMinutes(15)).toBe(15);
    expect(idleLimitMinutes(60)).toBe(60);
    expect(idleLimitMinutes(120)).toBe(120);
    for (const bad of [14, 121, 0, -30, 30.5, Number.NaN, Infinity, "45", true]) {
      expect(idleLimitMinutes(bad), String(bad)).toBe(30);
    }
  });

  it("uses the same bounds as network.session_idle_minutes", () => {
    const entry = SETTINGS_CATALOGUE.find((e) => e.key === "network.session_idle_minutes");
    expect(entry).toMatchObject({ min: SESSION_IDLE_MIN_MINUTES, max: SESSION_IDLE_MAX_MINUTES });
  });
});

describe("idle tracker (SRV-1401, M1.6)", () => {
  it("a token never seen is active and holds no entry", async () => {
    const tracker = createIdleTracker(clock());
    expect(await tracker.check(TOKEN_A)).toBe("active");
    expect(tracker.size()).toBe(0);
  });

  it("a session idle longer than the limit is expired; exactly the limit too", async () => {
    const c = clock();
    const tracker = createIdleTracker(c);
    tracker.touch(TOKEN_A);
    c.advance(30 * MINUTE - 1);
    expect(await tracker.check(TOKEN_A)).toBe("active");
    c.advance(1);
    expect(await tracker.check(TOKEN_A)).toBe("expired");
  });

  it("an active session is extended by each accepted request", async () => {
    const c = clock();
    const tracker = createIdleTracker(c);
    tracker.touch(TOKEN_A);
    for (let i = 0; i < 6; i++) {
      c.advance(20 * MINUTE);
      expect(await tracker.check(TOKEN_A)).toBe("active");
      tracker.touch(TOKEN_A);
    }
  });

  it("an expired session stays expired: a touch or a longer limit does not revive it", async () => {
    const c = clock();
    let minutes = 30;
    const tracker = createIdleTracker({ ...c, minutesFor: async () => minutes });
    tracker.touch(TOKEN_A);
    c.advance(31 * MINUTE);
    expect(await tracker.check(TOKEN_A)).toBe("expired");
    tracker.touch(TOKEN_A);
    minutes = 120;
    expect(await tracker.check(TOKEN_A)).toBe("expired");
  });

  it("reads the institution's limit per token", async () => {
    const c = clock();
    const tracker = createIdleTracker({
      ...c,
      minutesFor: async (token) => (token === TOKEN_A ? 15 : 60),
    });
    tracker.touch(TOKEN_A);
    tracker.touch(TOKEN_B);
    c.advance(16 * MINUTE);
    expect(await tracker.check(TOKEN_A)).toBe("expired");
    expect(await tracker.check(TOKEN_B)).toBe("active");
  });

  it("a failing or out-of-bounds limit falls back to 30 minutes", async () => {
    for (const minutesFor of [
      async () => {
        throw new Error("down");
      },
      async () => 5,
      async () => null,
    ]) {
      const c = clock();
      const tracker = createIdleTracker({ ...c, minutesFor });
      tracker.touch(TOKEN_A);
      c.advance(29 * MINUTE);
      expect(await tracker.check(TOKEN_A)).toBe("active");
      c.advance(MINUTE);
      expect(await tracker.check(TOKEN_A)).toBe("expired");
    }
  });

  it("drops entries idle for the database's two hours, and the oldest past capacity", async () => {
    const c = clock();
    const tracker = createIdleTracker({ ...c, capacity: 2 });
    tracker.touch(TOKEN_A);
    tracker.touch(TOKEN_B);
    tracker.touch(TOKEN_A);
    tracker.touch(TOKEN_C);
    // B was the least recently active.
    expect(tracker.size()).toBe(2);
    c.advance(10 * MINUTE);
    expect(await tracker.check(TOKEN_A)).toBe("active");
    c.advance(SESSION_IDLE_MAX_MINUTES * MINUTE);
    tracker.touch(TOKEN_B);
    expect(tracker.size()).toBe(1);
  });

  it("refuses a capacity below one", () => {
    expect(() => createIdleTracker({ capacity: 0 })).toThrow();
  });
});

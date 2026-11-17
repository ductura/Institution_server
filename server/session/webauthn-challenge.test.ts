// DAN-840-2a (S-1E-g): one-time WebAuthn challenges. Time moves only by the
// fake clock, or by a hand-written clock for what it refuses (going back).
import { createFakeClock } from "@ductura/test-fakes";
import { describe, expect, expectTypeOf, it } from "vitest";

import { hashSessionToken } from "./session-token.ts";
import {
  CHALLENGE_CAPACITY,
  createChallengeStore,
  type ChallengePurpose,
} from "./webauthn-challenge.ts";

const TTL = 60_000;
const keyOf = (token: string) => hashSessionToken(token).toString("base64url");
const SESSION = keyOf("izmisljeni-token-0001");
const OTHER = keyOf("izmisljeni-token-0002");

function setup(options: { capacity?: number; now?: () => number } = {}) {
  const clock = createFakeClock("2026-11-17T09:00:00.000Z");
  const store = createChallengeStore({ now: options.now ?? clock.nowMs, ttlMs: TTL, ...options });
  const issue = (key = SESSION, purpose: ChallengePurpose = "assertion") => {
    const issued = store.issue(key, purpose);
    if (issued === null) throw new Error("no challenge");
    return issued.challenge;
  };
  return { clock, store, issue };
}

describe("a challenge is refused once used or expired", () => {
  it("is ok once; a replay after success or after a failure is invalid", () => {
    const { store, issue } = setup();
    const first = issue();
    expect(store.take(SESSION, "assertion", first)).toBe("ok");
    expect(store.take(SESSION, "assertion", first)).toBe("invalid");
    const second = issue();
    expect(store.take(SESSION, "assertion", "A".repeat(43))).toBe("invalid");
    expect(store.take(SESSION, "assertion", second)).toBe("invalid");
  });

  it("expires at expiresAt: 1 ms before is ok, at and after are invalid", () => {
    for (const [advance, outcome] of [
      [TTL - 1, "ok"],
      [TTL, "invalid"],
      [TTL + 1, "invalid"],
    ] as const) {
      const { clock, store } = setup();
      const issued = store.issue(SESSION, "registration");
      expect(issued?.expiresAt).toBe(clock.nowMs() + TTL);
      clock.advance(advance);
      expect(store.take(SESSION, "registration", issued?.challenge)).toBe(outcome);
    }
  });

  it("refuses when the clock goes back, throws or gives no number", () => {
    let at = 1_000_000;
    const { store, issue } = setup({ now: () => at });
    const back = issue();
    at -= 1;
    expect(store.take(SESSION, "assertion", back)).toBe("invalid");
    for (const broken of [Number.NaN, Number.POSITIVE_INFINITY, "x", "throw"] as const) {
      at = 1_000_000;
      const challenge = issue();
      const now = () => {
        if (broken === "throw") throw new Error("izmisljena greska sata");
        return broken as number;
      };
      const failing = createChallengeStore({ now, ttlMs: TTL });
      expect(failing.issue(SESSION, "assertion")).toBeNull();
      at = Number.NaN;
      expect(store.take(SESSION, "assertion", challenge)).toBe("invalid");
    }
  });

  it("belongs to one session and one purpose; a new issue replaces the old one", () => {
    const { store, issue } = setup();
    expect(store.take(OTHER, "assertion", issue())).toBe("invalid");
    expect(store.take(SESSION, "registration", issue(SESSION, "assertion"))).toBe("invalid");
    const old = issue();
    const fresh = issue();
    expect(store.take(SESSION, "assertion", old)).toBe("invalid");
    expect(store.take(SESSION, "assertion", fresh)).toBe("invalid");
    // The registration challenge of the same session is its own.
    const registration = issue(SESSION, "registration");
    issue(SESSION, "assertion");
    expect(store.take(SESSION, "registration", registration)).toBe("ok");
  });

  it("refuses another spelling of the same bytes in the last character", () => {
    const zeros = () => new Uint8Array(32);
    const store = createChallengeStore({ now: () => 0, ttlMs: TTL, randomBytes: zeros });
    const challenge = store.issue(SESSION, "assertion")?.challenge ?? "";
    expect(challenge.endsWith("A")).toBe(true);
    const other = `${challenge.slice(0, -1)}B`;
    expect(Buffer.from(other, "base64url")).toEqual(Buffer.from(challenge, "base64url"));
    expect(store.take(SESSION, "assertion", other)).toBe("invalid");
  });
});

describe("inputs take refuses", () => {
  const bad: unknown[] = [
    ...["", "=", "a+b", "a/b", "a\tb", "a\r\nb", "a b", "a\u007fb"],
    ...["A".repeat(42), "A".repeat(44), `${"A".repeat(43)}\n`, `${"A".repeat(42)}=`],
    ...[43, null, undefined, {}, ["A".repeat(43)], "__proto__", "toString"],
  ];
  it.each(bad)("%j as the challenge", (value) => {
    const { store, issue } = setup();
    issue();
    expect(store.take(SESSION, "assertion", value)).toBe("invalid");
  });

  // __proto__ and toString fail the 43-character form before any Map lookup.
  it.each(bad)("%j as the session key", (value) => {
    const { store, issue } = setup();
    const challenge = issue();
    expect(store.take(value, "assertion", challenge)).toBe("invalid");
    expect(() => store.issue(value as string, "assertion")).toThrow(TypeError);
  });

  it.each(["login", "", "Assertion", "__proto__", null])("%j as the purpose", (purpose) => {
    const { store, issue } = setup();
    const challenge = issue();
    expect(store.take(SESSION, purpose, challenge)).toBe("invalid");
    expect(() => store.issue(SESSION, purpose as ChallengePurpose)).toThrow(TypeError);
  });
});

describe("memory and options", () => {
  it("when full, the oldest challenge goes, expired or not", () => {
    const { clock, store, issue } = setup({ capacity: 3 });
    const keys = ["a", "b", "c", "d", "e"].map((n) => keyOf(`izmisljeni-token-${n}`));
    const a = issue(keys[0]);
    clock.advance(TTL);
    const b = issue(keys[1]);
    const c = issue(keys[2]);
    const d = issue(keys[3]); // a, the oldest (and expired), goes; b stays.
    expect(store.take(keys[1], "assertion", b)).toBe("ok");
    issue(keys[1]);
    const e = issue(keys[4]); // full again with c, d and b: the oldest live one, c, goes.
    expect(store.take(keys[2], "assertion", c)).toBe("invalid");
    expect(store.take(keys[3], "assertion", d)).toBe("ok");
    expect(store.take(keys[4], "assertion", e)).toBe("ok");
    expect(store.take(keys[0], "assertion", a)).toBe("invalid");
  });

  // Review c.6935975815: with a clock that went back, the oldest is not the
  // first to expire, so expired challenges go before any live one.
  it("when full, drops an expired challenge before a live older one", () => {
    let at = 1000;
    const store = createChallengeStore({ now: () => at, ttlMs: 1000, capacity: 2 });
    const a = keyOf("izmisljeni-token-a");
    const b = keyOf("izmisljeni-token-b");
    const c = keyOf("izmisljeni-token-c");
    const first = store.issue(a, "assertion")?.challenge; // valid until 2000
    at = 0;
    store.issue(b, "assertion"); // valid until 1000
    at = 1500;
    const third = store.issue(c, "assertion")?.challenge;
    expect(store.take(a, "assertion", first)).toBe("ok");
    expect(store.take(c, "assertion", third)).toBe("ok");
  });

  it.each([0, -1, 1.5, Number.NaN, 600_001])("refuses %j as ttlMs or capacity", (value) => {
    expect(() => createChallengeStore({ now: () => 0, ttlMs: value })).toThrow(RangeError);
    expect(() => createChallengeStore({ now: () => 0, ttlMs: 1, capacity: value })).toThrow(
      RangeError,
    );
  });

  it("accepts the bounds and refuses a capacity above the constant", () => {
    expect(() => createChallengeStore({ now: () => 0, ttlMs: 600_000 })).not.toThrow();
    expect(() =>
      createChallengeStore({ now: () => 0, ttlMs: 1, capacity: CHALLENGE_CAPACITY + 1 }),
    ).toThrow(RangeError);
  });

  it("take stays synchronous, so no request runs between its read and its delete", () => {
    const { store } = setup();
    expectTypeOf(store.take).returns.toEqualTypeOf<"ok" | "invalid">();
  });
});

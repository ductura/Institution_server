// DAN-827 (S-1D-a; contract on Ductus#1836, c.6914672657): the state of a
// session as identity.session_state returns it. The parser is the one place
// that reads that row, so a value outside the closed lists never reaches a
// caller as a state.
import { describe, expect, it } from "vitest";
import { ENDED_REASONS, INTERRUPTED_REASONS, parseSessionState, SESSION_STATES } from "./state.ts";

const INVALID = { code: "SESSION_STATE_INVALID", messageKey: "errors.internal" };

function rejected(row: unknown): void {
  expect(parseSessionState(row)).toEqual({ ok: false, error: INVALID });
}

describe("session states", () => {
  it("are the four of S-1D-a, in_progress included", () => {
    expect(SESSION_STATES).toEqual(["in_progress", "active", "interrupted", "ended"]);
  });

  it("name idleness and a change of institution as reasons of an interruption", () => {
    expect(INTERRUPTED_REASONS).toEqual([
      "idle",
      "institution_changed",
      "issuer_removed",
      "operator",
      "superseded",
    ]);
    expect(ENDED_REASONS).toEqual(["logout", "logout_all", "backchannel_logout", "expired"]);
  });

  it("share no reason between interrupted and ended", () => {
    const ended: readonly string[] = ENDED_REASONS;
    expect(INTERRUPTED_REASONS.filter((reason) => ended.includes(reason))).toEqual([]);
  });

  it("are frozen", () => {
    expect(Object.isFrozen(SESSION_STATES)).toBe(true);
    expect(Object.isFrozen(INTERRUPTED_REASONS)).toBe(true);
    expect(Object.isFrozen(ENDED_REASONS)).toBe(true);
  });
});

describe("parseSessionState", () => {
  it("reads a state without a reason", () => {
    expect(parseSessionState({ state: "active", reason: null })).toEqual({
      ok: true,
      value: { state: "active", reason: null },
    });
    expect(parseSessionState({ state: "in_progress", reason: null })).toEqual({
      ok: true,
      value: { state: "in_progress", reason: null },
    });
  });

  it("reads every reason of its own state", () => {
    for (const reason of INTERRUPTED_REASONS) {
      expect(parseSessionState({ state: "interrupted", reason })).toEqual({
        ok: true,
        value: { state: "interrupted", reason },
      });
    }
    for (const reason of ENDED_REASONS) {
      expect(parseSessionState({ state: "ended", reason })).toEqual({
        ok: true,
        value: { state: "ended", reason },
      });
    }
  });

  it("returns a new object, not the row", () => {
    const row = { state: "ended", reason: "logout" };
    const parsed = parseSessionState(row);
    expect(parsed.ok && parsed.value).not.toBe(row);
  });

  it("refuses a reason of the other state or a missing one", () => {
    rejected({ state: "interrupted", reason: "logout" });
    rejected({ state: "ended", reason: "idle" });
    rejected({ state: "interrupted", reason: null });
    rejected({ state: "ended", reason: null });
    rejected({ state: "active", reason: "idle" });
    rejected({ state: "in_progress", reason: "logout" });
  });

  it("refuses an unknown state or reason", () => {
    rejected({ state: "closed", reason: null });
    rejected({ state: "ended", reason: "timeout" });
    rejected({ state: "", reason: null });
    rejected({ state: "ACTIVE", reason: null });
  });

  it("refuses a value with any extra character", () => {
    for (const extra of [" ", "\t", "\r\n", "\n", " ", "\u007f", "\u0000", "​"]) {
      rejected({ state: `active${extra}`, reason: null });
      rejected({ state: `${extra}active`, reason: null });
      rejected({ state: "ended", reason: `logout${extra}` });
      rejected({ state: "interrupted", reason: `${extra}idle` });
    }
  });

  it("refuses values that are not strings or null", () => {
    rejected({ state: ["active"], reason: null });
    rejected({ state: 1, reason: null });
    rejected({ state: "active", reason: undefined });
    rejected({ state: "active", reason: "" });
    rejected({ state: "ended", reason: ["logout"] });
    rejected({ state: { toString: () => "active" }, reason: null });
  });

  it("refuses a row with a missing or an extra column", () => {
    rejected({ state: "active" });
    rejected({ reason: null });
    rejected({ state: "active", reason: null, sessionId: "x" });
    rejected({});
  });

  it("refuses inherited columns and names of Object.prototype", () => {
    rejected(Object.create({ state: "active", reason: null }));
    const inherited: Record<string, unknown> = Object.create({ reason: null });
    inherited["state"] = "active";
    rejected(inherited);
    rejected({ state: "toString", reason: null });
    rejected({ state: "__proto__", reason: null });
    rejected({ state: "ended", reason: "constructor" });
    rejected({ state: "ended", reason: "hasOwnProperty" });
    rejected(JSON.parse('{"state":"active","reason":null,"__proto__":{"x":1}}'));
  });

  it("refuses an accessor instead of a value", () => {
    const row = { reason: null } as Record<string, unknown>;
    Object.defineProperty(row, "state", { enumerable: true, get: () => "active" });
    rejected(row);
  });

  it("refuses what is not a plain object", () => {
    for (const row of [null, undefined, "active", 1, true, [], ["active", null], new Map()]) {
      rejected(row);
    }
  });
});

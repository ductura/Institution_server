import { createFakeClock } from "@ductura/test-fakes";
import { describe, expect, it, vi } from "vitest";

import { checkEvent } from "../log/index.ts";

import { createSessionEvents, type SessionTransition } from "./events.ts";
import { ENDED_REASONS, INTERRUPTED_REASONS } from "./state.ts";

// DAN-830-1 (contract Ductus#1836 c.6917690910): every session transition handed
// to `record` gives exactly one checked record to the log writer; anything
// else gives none. All values are invented.
const REQUEST_A = "6f1c2d3e-4a5b-4c6d-8e7f-901234567890";
const REQUEST_B = "0a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d";
const START = "2026-11-16T12:00:00.000Z";
const actor = (requestId = REQUEST_A) => ({ requestId, accountKind: "student" });

type Written = { time: string; event: string; requestId: string; fields: object };

function setup(write: (record: Written) => unknown = () => Promise.resolve({ ok: true })) {
  const clock = createFakeClock(START);
  const port = vi.fn(write);
  const record = createSessionEvents({ write: port as never, now: clock.now });
  return { clock, port, record };
}

const EXPECTED: [SessionTransition, string, Record<string, unknown>][] = [
  [{ to: "active", secondFactor: false }, "session.created", { secondFactor: false }],
  [{ to: "active", secondFactor: true }, "session.created", { secondFactor: true }],
  [{ to: "interrupted", reason: "idle" }, "session.expired", { reason: "idle" }],
  [{ to: "ended", reason: "expired" }, "session.expired", { reason: "absolute" }],
  ...(["institution_changed", "issuer_removed", "operator", "superseded"] as const).map(
    (reason): [SessionTransition, string, Record<string, unknown>] => [
      { to: "interrupted", reason },
      "session.revoked",
      { reason },
    ],
  ),
  ...(["logout", "logout_all", "backchannel_logout"] as const).map(
    (reason): [SessionTransition, string, Record<string, unknown>] => [
      { to: "ended", reason },
      "session.revoked",
      { reason },
    ],
  ),
];

describe("record: refused transitions write nothing", () => {
  const badTransitions: unknown[] = [
    undefined,
    null,
    "active",
    [],
    { to: "in_progress", reason: null },
    { to: "__proto__", reason: "idle" },
    { to: "toString", reason: "idle" },
    { to: "constructor", reason: "idle" },
    { to: "", reason: "idle" },
    { to: "ended", reason: "idle" },
    { to: "interrupted", reason: "logout" },
    { to: "ended", reason: "__proto__" },
    { to: "ended", reason: "toString" },
    ...["logout\r\n", "logout\t", "logout ", "logout\u007f", "LOGOUT", " logout"].map((reason) => ({
      to: "ended",
      reason,
    })),
    { to: "ended", reason: "logout", extra: 1 },
    { to: "active", secondFactor: false, reason: "idle" },
    { to: "active" },
    { to: "ended" },
    Object.create({ to: "ended", reason: "logout" }),
    Object.defineProperty({ to: "ended" }, "reason", { enumerable: true, get: () => "logout" }),
    new Proxy({ to: "ended", reason: "logout" }, {}),
    new (class {
      to = "ended";
      reason = "logout";
    })(),
  ];
  it.each(badTransitions.map((t, i) => [i, t]))("transition %i → UNKNOWN_EVENT", (_, t) => {
    const { port, record } = setup();
    expect(record(actor(), t)).toMatchObject({ ok: false, error: { code: "UNKNOWN_EVENT" } });
    expect(port).not.toHaveBeenCalled();
  });

  const ok: SessionTransition = { to: "ended", reason: "logout" };
  const badActors: [unknown, string][] = [
    [null, "NOT_A_PLAIN_OBJECT"],
    ["student", "NOT_A_PLAIN_OBJECT"],
    [new Proxy(actor(), {}), "NOT_A_PLAIN_OBJECT"],
    [
      new (class {
        requestId = REQUEST_A;
        accountKind = "student";
      })(),
      "NOT_A_PLAIN_OBJECT",
    ],
    [Object.create(actor()), "NOT_A_PLAIN_OBJECT"],
    [{ ...actor(), requestId: "6F1C2D3E-4A5B-4C6D-8E7F-901234567890" }, "BAD_REQUEST_ID"],
    [{ ...actor(), requestId: `${REQUEST_A}\n` }, "BAD_REQUEST_ID"],
    [
      Object.defineProperty({ accountKind: "student" }, "requestId", { get: () => REQUEST_A }),
      "BAD_REQUEST_ID",
    ],
    [{ ...actor(), accountKind: "anonymous" }, "ACCOUNT_KIND_NOT_ALLOWED"],
    [{ ...actor(), accountKind: "__proto__" }, "UNKNOWN_ACCOUNT_KIND"],
    [{ ...actor(), accountKind: "student " }, "UNKNOWN_ACCOUNT_KIND"],
  ];
  it.each(badActors.map(([a, c], i) => [i, a, c]))("actor %i → %s", (_, a, code) => {
    const { port, record } = setup();
    expect(record(a, ok)).toMatchObject({ ok: false, error: { code } });
    expect(port).not.toHaveBeenCalled();
  });

  it("a non-boolean secondFactor is BAD_FIELD_VALUE", () => {
    const { port, record } = setup();
    for (const secondFactor of [1, "true", null, undefined]) {
      expect(record(actor(), { to: "active", secondFactor })).toMatchObject({
        error: { code: "BAD_FIELD_VALUE" },
      });
    }
    expect(port).not.toHaveBeenCalled();
  });

  it("a clock that throws or gives an invalid date is BAD_TIME", () => {
    for (const now of [
      () => {
        throw new Error("clock");
      },
      () => new Date(Number.NaN),
      () => "2026-11-16T12:00:00.000Z",
    ]) {
      const port = vi.fn();
      const record = createSessionEvents({ write: port, now: now as () => Date });
      expect(record(actor(), ok)).toMatchObject({ ok: false, error: { code: "BAD_TIME" } });
      expect(port).not.toHaveBeenCalled();
    }
  });
});

describe("record: every session transition gives exactly one event", () => {
  it("the table covers every reason of server/session/state.ts", () => {
    const covered = EXPECTED.map(([t]) => ("reason" in t ? `${t.to}:${t.reason}` : t.to));
    expect(new Set(covered)).toEqual(
      new Set([
        "active",
        ...INTERRUPTED_REASONS.map((r) => `interrupted:${r}`),
        ...ENDED_REASONS.map((r) => `ended:${r}`),
      ]),
    );
  });

  it.each(EXPECTED)("%j → %s", (transition, event, fields) => {
    const { port, record } = setup();
    const result = record(actor(), transition);
    const expected = { time: START, event, requestId: REQUEST_A, accountKind: "student", fields };
    expect(result).toEqual({ ok: true, value: expected });
    expect(port).toHaveBeenCalledTimes(1);
    expect(port.mock.calls[0]?.[0]).toEqual(expected);
    expect(checkEvent(port.mock.calls[0]?.[0])).toMatchObject({ ok: true });
  });

  it("the five transitions of the scope are named", () => {
    const { port, record } = setup();
    record(actor(), { to: "active", secondFactor: false });
    record(actor(), { to: "interrupted", reason: "idle" });
    record(actor(), { to: "ended", reason: "logout" });
    record(actor(), { to: "ended", reason: "logout_all" });
    record(actor(), { to: "interrupted", reason: "institution_changed" });
    expect(port.mock.calls.map(([r]) => [r.event, r.fields])).toEqual([
      ["session.created", { secondFactor: false }],
      ["session.expired", { reason: "idle" }],
      ["session.revoked", { reason: "logout" }],
      ["session.revoked", { reason: "logout_all" }],
      ["session.revoked", { reason: "institution_changed" }],
    ]);
  });

  it("only requestId and accountKind are read from the actor", () => {
    const { port, record } = setup();
    const leaky = {
      ...actor(),
      token: "kanarinac-token",
      cookie: "__Host-ductus_session=kanarinac",
      ip: "203.0.113.7",
    };
    record(leaky, { to: "ended", reason: "logout" });
    const written = port.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(Object.keys(written)).toEqual(["time", "event", "requestId", "accountKind", "fields"]);
    expect(JSON.stringify(written)).not.toMatch(/kanarinac|203\.0\.113/);
  });

  it("two interleaved calls give two records with their own request id and time", () => {
    const { clock, port, record } = setup();
    record(actor(REQUEST_A), { to: "ended", reason: "logout" });
    clock.advance(1_000);
    record(actor(REQUEST_B), { to: "interrupted", reason: "idle" });
    expect(port.mock.calls.map(([r]) => [r.requestId, r.time, r.event])).toEqual([
      [REQUEST_A, START, "session.revoked"],
      [REQUEST_B, "2026-11-16T12:00:01.000Z", "session.expired"],
    ]);
  });

  it("a port that throws or rejects does not change the answer: one attempt", async () => {
    for (const write of [
      () => {
        throw new Error("log store down");
      },
      () => Promise.reject(new Error("log store down")),
      () => new Promise(() => undefined),
    ]) {
      const { port, record } = setup(write);
      expect(record(actor(), { to: "ended", reason: "logout" })).toMatchObject({ ok: true });
      expect(port).toHaveBeenCalledTimes(1);
    }
    await new Promise((resolve) => setImmediate(resolve));
  });
});

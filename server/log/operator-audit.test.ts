import { readFileSync } from "node:fs";

import { createFakeClock } from "@ductura/test-fakes";
import { describe, expect, it, vi } from "vitest";

import { CANARY } from "./invented.fixture.ts";
import { createOperatorAudit, OPERATOR_AUDIT_ERROR_CODES } from "./operator-audit.ts";

// S-1J.4 (DAN-841, part 841-1; contract Ductus#1836 c.6917244458): an operator
// action runs only when its admin.action record is valid, and then gives
// exactly one write attempt with its outcome and nothing outside the catalog.

const REQUEST_ID = "3f2a7c1e-9b4d-4e8a-a1c2-0d5e6f708192";
const INSTITUTION_ID = "0b1c2d3e-4f50-4617-8293-a4b5c6d7e8f9";
const USER_ID = "7d8e9f00-1a2b-4c3d-8e4f-5a6b7c8d9e0f";
const ACTOR = {
  requestId: REQUEST_ID,
  accountKind: "app_admin",
  institutionId: INSTITUTION_ID,
  userId: USER_ID,
};
const ACTION = "manage_ip_rules";
const REFUSED = {
  code: "OPERATOR_AUDIT_REFUSED",
  messageKey: "operatorAudit.operator_audit_refused",
};

function setup(options: { now?: () => Date; write?: (record: unknown) => unknown } = {}) {
  const clock = createFakeClock("2026-11-16T09:30:00.000Z");
  const records: unknown[] = [];
  const write = vi.fn((record: unknown) => {
    records.push(record);
    return options.write?.(record) ?? Promise.resolve({ ok: true, value: record });
  });
  const audited = createOperatorAudit({ write: write as never, now: options.now ?? clock.now });
  const run = vi.fn(() => Promise.resolve({ ok: true as const, value: 7 }));
  return { clock, records, write, audited, run };
}

const BAD_TEXT = ["\r\n", "\t", String.fromCharCode(0xa0), "\u007f", " "];
const proto = (value: object) => Object.create(value) as object;
class Actor {
  requestId = REQUEST_ID;
  accountKind = "app_admin";
  institutionId = INSTITUTION_ID;
  userId = USER_ID;
}
const getter = { ...ACTOR };
Object.defineProperty(getter, "accountKind", { get: () => "app_admin", enumerable: true });
const userGetter = { ...ACTOR };
Object.defineProperty(userGetter, "userId", { get: () => USER_ID, enumerable: true });

const BAD_ACTORS: [string, unknown][] = [
  ...["student", "teacher", "anonymous", "__proto__", "toString"].map((kind): [string, unknown] => [
    `kind ${kind}`,
    { ...ACTOR, accountKind: kind },
  ]),
  ...BAD_TEXT.flatMap((bad): [string, unknown][] => [
    [`kind ${JSON.stringify(bad)}`, { ...ACTOR, accountKind: `app_admin${bad}` }],
    [`institution ${JSON.stringify(bad)}`, { ...ACTOR, institutionId: `${INSTITUTION_ID}${bad}` }],
    [`request ${JSON.stringify(bad)}`, { ...ACTOR, requestId: `${bad}${REQUEST_ID}` }],
    [`user ${JSON.stringify(bad)}`, { ...ACTOR, userId: `${USER_ID}${bad}` }],
  ]),
  ["upper-case user", { ...ACTOR, userId: USER_ID.toUpperCase() }],
  ["empty user", { ...ACTOR, userId: "" }],
  ["user not a UUID", { ...ACTOR, userId: "operator-1" }],
  ["no user", { ...ACTOR, userId: undefined }],
  [
    "user inherited",
    Object.assign(proto({ userId: USER_ID }), {
      requestId: REQUEST_ID,
      accountKind: "app_admin",
      institutionId: INSTITUTION_ID,
    }),
  ],
  ["upper-case id", { ...ACTOR, institutionId: INSTITUTION_ID.toUpperCase() }],
  ["empty id", { ...ACTOR, institutionId: "" }],
  ["no institution", { ...ACTOR, institutionId: null }],
  ["request id not v4", { ...ACTOR, requestId: "0b1c2d3e-4f50-1617-8293-a4b5c6d7e8f9" }],
  ["String object", { ...ACTOR, institutionId: new String(INSTITUTION_ID) }],
  ["null", null],
  ["a string", REQUEST_ID],
  ["inherited keys", proto(ACTOR)],
  ["class instance", new Actor()],
  ["getter", getter],
  ["user getter", userGetter],
  ["Proxy", new Proxy(ACTOR, {})],
];
const BAD_ACTIONS: unknown[] = [
  ...["delete_draft", "read_own_work", "constructor", "__proto__", "toString", "", 1],
  ...BAD_TEXT.map((bad) => `${ACTION}${bad}`),
];

describe("operator audit: refusals run nothing and write nothing", () => {
  it.each(BAD_ACTORS)("actor: %s", async (_name, actor) => {
    const { audited, run, write } = setup();
    await expect(audited(actor, ACTION, run)).resolves.toEqual({ ok: false, error: REFUSED });
    expect(run).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it.each(BAD_ACTIONS)("action: %j", async (action) => {
    const { audited, run, write } = setup();
    await expect(audited(ACTOR, action, run)).resolves.toEqual({ ok: false, error: REFUSED });
    expect(run).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it.each([
    ["invalid date", () => new Date(Number.NaN)],
    [
      "throwing clock",
      () => {
        throw new Error(CANARY);
      },
    ],
  ])("clock: %s", async (_name, now) => {
    const { audited, run, write } = setup({ now });
    await expect(audited(ACTOR, ACTION, run)).resolves.toEqual({ ok: false, error: REFUSED });
    expect(run).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });
});

const THROWN = new Error("x");

describe("operator audit: one write attempt with the outcome", () => {
  it.each([
    [
      "throws",
      () => {
        throw THROWN;
      },
    ],
    ["rejects", () => Promise.reject(THROWN)],
    [
      "throws undefined",
      () => {
        throw undefined;
      },
    ],
    ["rejects a string", () => Promise.reject("x")],
  ])("a run that %s is written failed and rethrown as is", async (_name, run) => {
    const { audited, records } = setup();
    let original: unknown = "not read";
    try {
      await run();
    } catch (error) {
      original = error;
    }
    let thrown: unknown = "nothing";
    await audited(ACTOR, ACTION, run as never).catch((error: unknown) => (thrown = error));
    expect(thrown).toBe(original);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ fields: { outcome: "failed" } });
  });

  it("writes succeeded for ok and failed for a refused Result", async () => {
    const { audited, records, run } = setup();
    await expect(audited(ACTOR, ACTION, run)).resolves.toEqual({ ok: true, value: 7 });
    const refused = { ok: false as const, error: { code: "X", messageKey: "x" } };
    await expect(audited(ACTOR, ACTION, () => refused)).resolves.toBe(refused);
    expect(run).toHaveBeenCalledTimes(1);
    expect(records).toEqual([
      {
        time: "2026-11-16T09:30:00.000Z",
        event: "admin.action",
        requestId: REQUEST_ID,
        accountKind: "app_admin",
        fields: {
          action: ACTION,
          outcome: "succeeded",
          institutionId: INSTITUTION_ID,
          userId: USER_ID,
        },
      },
      expect.objectContaining({ fields: expect.objectContaining({ outcome: "failed" }) }),
    ]);
  });

  it.each([
    [
      "throws",
      () => {
        throw new Error(CANARY);
      },
    ],
    ["rejects", () => Promise.reject(new Error(CANARY))],
  ])("a write port that %s changes nothing, even when run fails too", async (_name, fail) => {
    const { audited, write } = setup({ write: fail });
    await expect(audited(ACTOR, ACTION, () => ({ ok: true, value: 1 }))).resolves.toEqual({
      ok: true,
      value: 1,
    });
    await expect(audited(ACTOR, ACTION, () => Promise.reject(new Error("y")))).rejects.toThrow("y");
    expect(write).toHaveBeenCalledTimes(2);
  });

  it("carries only the catalog's keys: no ip, token, email or cookie", async () => {
    const { audited, records } = setup();
    const actor = {
      ...ACTOR,
      ip: "203.0.113.7",
      ipv6: "2001:db8::1",
      token: CANARY,
      email: `${CANARY}@primjer.invalid`,
      cookie: CANARY,
    };
    await audited(actor, ACTION, () => ({ ok: true, value: 1 }));
    const text = JSON.stringify(records);
    for (const leak of [CANARY, "203.0.113", "2001:db8"]) expect(text).not.toContain(leak);
    expect(Object.keys(records[0] as object).sort()).toEqual([
      "accountKind",
      "event",
      "fields",
      "requestId",
      "time",
    ]);
  });

  it("uses the actor as read before run, at the time run ends; null-prototype and frozen actors pass", async () => {
    const { audited, records, clock } = setup();
    const actor: Record<string, unknown> = { ...ACTOR };
    await audited(actor, ACTION, () => {
      actor.accountKind = "student";
      clock.advance(1500);
      return { ok: true, value: 1 };
    });
    expect(records[0]).toMatchObject({
      accountKind: "app_admin",
      time: "2026-11-16T09:30:01.500Z",
    });
    const bare = Object.assign(Object.create(null) as object, ACTOR);
    await expect(audited(bare, ACTION, () => ({ ok: true, value: 2 }))).resolves.toMatchObject({
      ok: true,
    });
    await expect(
      audited(Object.freeze({ ...ACTOR }), ACTION, () => ({ ok: true, value: 3 })),
    ).resolves.toMatchObject({ ok: true });
    expect(records).toHaveLength(3);
  });

  it("keeps two interleaved calls apart", async () => {
    const { audited, records } = setup();
    const other = { ...ACTOR, requestId: "5e6f7081-92a3-44b5-86c7-d8e9f0a1b2c3" };
    let release = (): void => undefined;
    const first = audited(
      ACTOR,
      ACTION,
      () =>
        new Promise<{ ok: true; value: number }>(
          (resolve) => (release = () => resolve({ ok: true, value: 1 })),
        ),
    );
    await audited(other, "export_logs", () => Promise.reject(new Error("z"))).catch(
      () => undefined,
    );
    release();
    await first;
    expect(records).toEqual([
      expect.objectContaining({
        requestId: other.requestId,
        fields: expect.objectContaining({ action: "export_logs", outcome: "failed" }),
      }),
      expect.objectContaining({
        requestId: REQUEST_ID,
        fields: expect.objectContaining({ action: ACTION, outcome: "succeeded" }),
      }),
    ]);
  });

  it("answers while the write still waits", async () => {
    const { audited, write } = setup({ write: () => new Promise(() => undefined) });
    await expect(audited(ACTOR, ACTION, () => ({ ok: true, value: 1 }))).resolves.toEqual({
      ok: true,
      value: 1,
    });
    expect(write).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      "throws",
      () => {
        throw new Error(CANARY);
      },
    ],
    ["gives an invalid date", () => new Date(Number.NaN)],
  ])("a clock that %s after the start keeps the start time", async (_name, broken) => {
    const clock = createFakeClock("2026-11-16T09:30:00.000Z");
    let calls = 0;
    const now = () => (calls++ === 0 ? clock.now() : broken());
    const { audited, records } = setup({ now });
    await expect(audited(ACTOR, ACTION, () => ({ ok: true, value: 4 }))).resolves.toEqual({
      ok: true,
      value: 4,
    });
    expect(records).toEqual([
      expect.objectContaining({
        time: "2026-11-16T09:30:00.000Z",
        fields: expect.objectContaining({ outcome: "succeeded", userId: USER_ID }),
      }),
    ]);
  });

  it("has a Croatian text for every code it answers with", () => {
    const texts = JSON.parse(
      readFileSync(new URL("../../locales/hr.json", import.meta.url), "utf8"),
    ) as {
      operatorAudit: Record<string, string>;
    };
    expect(Object.keys(texts.operatorAudit)).toEqual(
      OPERATOR_AUDIT_ERROR_CODES.map((code) => code.toLowerCase()),
    );
  });
});

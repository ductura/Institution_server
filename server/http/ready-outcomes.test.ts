// Readiness outcomes (S-1E-d, DAN-839-3a; port of Ductus src/server/ready.ts at
// b36c82b): a service answer becomes a contract word only when it is recognised
// exactly; anything else throws a log-only code the core turns into
// "nedostupno". Contract: Ductus#1836 c.6931237510.
import { createFakeClock } from "@ductura/test-fakes/clock";
import { describe, expect, it, vi } from "vitest";

import { SIGNING_ERRORS } from "../external/keys/index.ts";
import { classifyQueue, classifyStorage, signingOutcome, singleFlight } from "./ready-outcomes.ts";
import { createReadyCheck, type ReadyCapabilityName } from "./ready.ts";

const CANARY = "kms.invalid:443 key 16.4";
const codeOf = (run: () => unknown): unknown => {
  try {
    run();
  } catch (error) {
    expect(String((error as Error).message)).not.toContain("invalid");
    return (error as { code?: unknown }).code;
  }
  return "no throw";
};
const rejectionCode = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => "no throw",
    (error: unknown) => (error as { code?: unknown }).code,
  );
const inherited = (key: string, value: unknown): object =>
  Object.create({ [key]: value }) as object;
const getter = (key: string, value: unknown): object =>
  Object.defineProperty({}, key, { get: () => value, enumerable: true });
const trap = (): object =>
  new Proxy(
    {},
    {
      getOwnPropertyDescriptor: () => {
        throw new Error(CANARY);
      },
      ownKeys: () => {
        throw new Error(CANARY);
      },
    },
  );
const WORDS = ["OK", "ok\n", "ok\r\n", "ok\t", "ok ", "ok\u007f", " ok", "nedostupno"];

describe("classifyQueue", () => {
  it.each([
    ...WORDS.map((queue) => ({ queue })),
    { queue: new String("ok") },
    { queue: 1 },
    {},
    null,
    undefined,
    "ok",
    inherited("queue", "ok"),
    getter("queue", "ok"),
    trap(),
    new (class Row {
      queue = "ok";
    })(),
  ])("refuses case %#", (row) => {
    expect(codeOf(() => classifyQueue(row))).toBe("QUEUE_WORKER");
  });

  it("queue passes only the two exact words", () => {
    expect(classifyQueue({ queue: "ok" })).toBe("ok");
    expect(classifyQueue(JSON.parse('{"queue":"nije_konfigurirano"}'))).toBe("nije_konfigurirano");
    expect(classifyQueue(Object.assign(Object.create(null) as object, { queue: "ok" }))).toBe("ok");
  });
});

describe("classifyStorage", () => {
  it.each([
    { a: "unverified" },
    { a: "disabled" },
    { a: "verified", b: "unverified" },
    { a: "verified " },
    { a: "Verified" },
    { a: "verified " },
    JSON.parse('{"__proto__":"disabled"}') as unknown,
    null,
    1,
    "not_configured\n",
    ["verified"],
    getter("a", "verified"),
    Object.defineProperty({}, "a", { value: "disabled", enumerable: false }),
    Object.defineProperty({}, "a", { value: "verified", enumerable: false }),
    { [Symbol("a")]: "verified" },
    inherited("toString", "verified"),
    trap(),
  ])("refuses case %#", (states) => {
    expect(codeOf(() => classifyStorage(states))).toBe("STORAGE_DOMAIN");
  });

  it("storage is ok only when every domain is verified", () => {
    expect(classifyStorage("not_configured")).toBe("nije_konfigurirano");
    expect(classifyStorage({})).toBe("nije_konfigurirano");
    expect(classifyStorage(Object.create(null))).toBe("nije_konfigurirano");
    expect(classifyStorage({ a: "verified", b: "verified" })).toBe("ok");
  });
});

describe("signingOutcome", () => {
  const port = (result: unknown) => () => Promise.resolve(result) as never;

  it.each([
    { ok: "true" },
    { ok: 1 },
    inherited("ok", true),
    null,
    undefined,
    { ok: false },
    { ok: false, error: { code: "SIGNING_KEY_NOT_CONFIGURED\n" } },
    { ok: false, error: { code: "signing_key_not_configured" } },
    { ok: false, error: { code: CANARY } },
    { ok: false, error: inherited("code", "SIGNING_KEY_NOT_CONFIGURED") },
    { ok: false, error: getter("code", "SIGNING_KEY_NOT_CONFIGURED") },
    trap(),
  ])("refuses case %#", async (result) => {
    await expect(rejectionCode(signingOutcome(port(result)))).resolves.toBe("SIGNING");
  });

  it("a port that throws or rejects is SIGNING, whatever its code", async () => {
    const thrown = Object.assign(new Error(CANARY), { code: "SIGNING_KEY_NOT_CONFIGURED" });
    const throws = () => {
      throw thrown;
    };
    await expect(rejectionCode(signingOutcome(throws))).resolves.toBe("SIGNING");
    await expect(rejectionCode(signingOutcome(() => Promise.reject(thrown)))).resolves.toBe(
      "SIGNING",
    );
  });

  it("signing maps the port result", async () => {
    await expect(signingOutcome(port({ ok: true, value: {} }))).resolves.toBe("ok");
    const missing = { code: "SIGNING_KEY_NOT_CONFIGURED", messageKey: "x" };
    await expect(signingOutcome(port({ ok: false, error: missing }))).resolves.toBe(
      "nije_konfigurirano",
    );
    for (const error of SIGNING_ERRORS.filter((e) => e.code !== missing.code))
      await expect(rejectionCode(signingOutcome(port({ ok: false, error })))).resolves.toBe(
        error.code,
      );
  });
});

describe("singleFlight", () => {
  it("single flight shares one call until it settles", async () => {
    let release: (value: string) => void = () => {};
    const fn = vi.fn(() => new Promise<string>((resolve) => (release = resolve)));
    const shared = singleFlight(fn);
    const calls = [shared(), shared(), shared()];
    expect(calls[1]).toBe(calls[0]);
    expect(calls[2]).toBe(calls[0]);
    await Promise.resolve();
    release("ok");
    await expect(Promise.all(calls)).resolves.toEqual(["ok", "ok", "ok"]);
    expect(fn).toHaveBeenCalledTimes(1);
    const next = shared();
    expect(next).not.toBe(calls[0]);
    await Promise.resolve();
    release("again");
    await expect(next).resolves.toBe("again");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("a sync throw is a rejection, leaks nothing, and the next call starts anew", async () => {
    const seen: unknown[] = [];
    const listener = (reason: unknown) => seen.push(reason);
    process.on("unhandledRejection", listener);
    try {
      let n = 0;
      const shared = singleFlight(() => {
        n += 1;
        if (n === 1) throw new Error(CANARY);
        return Promise.resolve(n);
      });
      const first = shared();
      expect(n).toBe(0);
      await expect(first).rejects.toThrow(CANARY);
      await expect(shared()).resolves.toBe(2);
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.off("unhandledRejection", listener);
    }
    expect(seen).toEqual([]);
  });
});

describe("through the readiness core", () => {
  it("a classifier refusal reaches the report as its code", async () => {
    const clock = createFakeClock();
    const failing = (code: string) => {
      const error = SIGNING_ERRORS.find((e) => e.code === code) ?? { code, messageKey: "x" };
      return signingOutcome(() => Promise.resolve({ ok: false, error }) as never);
    };
    const cases: readonly [
      ReadyCapabilityName,
      () => Promise<"ok" | "nije_konfigurirano">,
      string,
    ][] = [
      ["queue", async () => classifyQueue({ queue: "ok\n" }), "QUEUE_WORKER"],
      ["storage", async () => classifyStorage({ a: "disabled" }), "STORAGE_DOMAIN"],
      ["signing", () => failing(CANARY), "SIGNING"],
    ];
    const signingCodes = SIGNING_ERRORS.map((e) => e.code).filter(
      (code) => code !== "SIGNING_KEY_NOT_CONFIGURED",
    );
    for (const [name, probe, code] of [
      ...cases,
      ...signingCodes.map((code) => ["signing", () => failing(code), code] as const),
    ]) {
      const check = createReadyCheck([{ name, required: false, timeoutMs: 100, probe }], {
        now: () => clock.nowMs(),
        sleep: (ms, signal) => clock.sleep(ms, signal),
      });
      const report = await check();
      expect(report).toEqual({
        ready: true,
        capabilities: { [name]: "nedostupno" },
        codes: { [name]: code },
      });
      expect(JSON.stringify(report)).not.toContain("invalid");
    }
  });
});

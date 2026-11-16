// Readiness outcomes (S-1E-d, DAN-839-3a; port of Ductus src/server/ready.ts at
// b36c82b): a service answer becomes a contract word only when it is recognised
// exactly; anything else is a returned AppError (docs/CODE_STYLE.md §8), never
// a throw. Contract: Ductus#1836 c.6931237510.
import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { SIGNING_ERRORS } from "../external/keys/index.ts";
import {
  classifyQueue,
  classifyStorage,
  READY_ERRORS,
  READY_SIGNING,
  READY_STORAGE_DOMAIN,
  READY_QUEUE_WORKER,
  signingOutcome,
  singleFlight,
} from "./ready-outcomes.ts";

const CANARY = "kms.invalid:443 key 16.4";
const catalogue: unknown = JSON.parse(
  readFileSync(new URL("../../locales/hr.json", import.meta.url), "utf8"),
);
const textAt = (key: string): unknown =>
  key
    .split(".")
    .reduce<unknown>(
      (node, part) =>
        node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined,
      catalogue,
    );
const ok = (value: string) => ({ ok: true, value });
const fails = (error: unknown) => ({ ok: false, error });
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
    expect(classifyQueue(row)).toEqual(fails(READY_QUEUE_WORKER));
  });

  it("queue passes only the two exact words", () => {
    expect(classifyQueue({ queue: "ok" })).toEqual(ok("ok"));
    expect(classifyQueue(JSON.parse('{"queue":"nije_konfigurirano"}'))).toEqual(
      ok("nije_konfigurirano"),
    );
    expect(classifyQueue(Object.assign(Object.create(null) as object, { queue: "ok" }))).toEqual(
      ok("ok"),
    );
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
    expect(classifyStorage(states)).toEqual(fails(READY_STORAGE_DOMAIN));
  });

  it("storage is ok only when every domain is verified", () => {
    expect(classifyStorage("not_configured")).toEqual(ok("nije_konfigurirano"));
    expect(classifyStorage({})).toEqual(ok("nije_konfigurirano"));
    expect(classifyStorage(Object.create(null))).toEqual(ok("nije_konfigurirano"));
    expect(classifyStorage({ a: "verified", b: "verified" })).toEqual(ok("ok"));
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
    await expect(signingOutcome(port(result))).resolves.toEqual(fails(READY_SIGNING));
  });

  it("a port that throws or rejects is SIGNING, whatever its code", async () => {
    const thrown = Object.assign(new Error(CANARY), { code: "SIGNING_KEY_NOT_CONFIGURED" });
    const throws = () => {
      throw thrown;
    };
    await expect(signingOutcome(throws)).resolves.toEqual(fails(READY_SIGNING));
    await expect(signingOutcome(() => Promise.reject(thrown))).resolves.toEqual(
      fails(READY_SIGNING),
    );
  });

  it("signing maps the port result", async () => {
    await expect(signingOutcome(port({ ok: true, value: {} }))).resolves.toEqual(ok("ok"));
    const missing = { code: "SIGNING_KEY_NOT_CONFIGURED", messageKey: "x" };
    await expect(signingOutcome(port({ ok: false, error: missing }))).resolves.toEqual(
      ok("nije_konfigurirano"),
    );
    for (const error of SIGNING_ERRORS.filter((e) => e.code !== missing.code)) {
      const copy = { code: error.code, messageKey: CANARY };
      // The port's own AppError comes back, not whatever key the answer carried.
      await expect(signingOutcome(port({ ok: false, error: copy }))).resolves.toEqual(fails(error));
    }
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

describe("returned errors (docs/CODE_STYLE.md §8)", () => {
  it("each has a Croatian text and a code the readiness core keeps", () => {
    for (const { code, messageKey } of [...READY_ERRORS, ...SIGNING_ERRORS]) {
      const text = textAt(messageKey);
      expect(typeof text === "string" && text.trim().length > 0, messageKey).toBe(true);
      // The core's code shape (ready.ts), so 839-3b can report it as given.
      expect(code).toMatch(/^[A-Z0-9_]{1,32}$/);
    }
    expect(new Set(READY_ERRORS.map((e) => e.code)).size).toBe(READY_ERRORS.length);
    expect(Object.keys(textAt("ready") as object).sort()).toEqual(
      READY_ERRORS.map((e) => e.messageKey.replace("ready.", "")).sort(),
    );
  });

  it("no outcome throws, whatever it is given", async () => {
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf: () => {
          throw new Error(CANARY);
        },
      },
    );
    expect(classifyQueue(hostile)).toEqual(fails(READY_QUEUE_WORKER));
    expect(classifyStorage(hostile)).toEqual(fails(READY_STORAGE_DOMAIN));
    await expect(signingOutcome(() => Promise.resolve(hostile) as never)).resolves.toEqual(
      fails(READY_SIGNING),
    );
  });
});

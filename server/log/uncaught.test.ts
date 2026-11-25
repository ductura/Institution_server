import { EventEmitter } from "node:events";

import { describe, expect, it } from "vitest";

import { CANARY } from "./invented.fixture.ts";
import {
  createLogger,
  createUncaughtCapture,
  errorClassOf,
  EVENT_CATALOG,
  installUncaughtCapture,
  UNCAUGHT_ERROR_CLASSES,
  type UncaughtGroup,
} from "./index.ts";

/** DAN-1567. Invented values only; the canary stands for text that must never be written. */

function recorder() {
  const lines: string[] = [];
  let time = 0;
  const raised: UncaughtGroup[] = [];
  const capture = createUncaughtCapture({
    log: createLogger(
      (_level, line) => lines.push(line),
      () => new Date(0),
    ),
    now: () => time,
    windowMs: 1000,
    raise: (group) => raised.push(group),
  });
  return { lines, raised, capture, advance: (ms: number) => (time += ms) };
}
const parsed = (lines: string[]) =>
  lines.map((line) => JSON.parse(line) as { event: string; fields: Record<string, unknown> });

describe("createUncaughtCapture", () => {
  it("writes one line of closed codes and nothing of the error itself", () => {
    const { lines, capture } = recorder();
    const error = new TypeError(`${CANARY} ana.izmisljena@student.example.invalid`);
    Object.assign(error, { userId: "3f0e7c0a-5b1d-4c7e-9a52-0d6f1b2c3d4e", body: CANARY });
    expect(capture.capture("uncaught_exception", error)).toBe(true);
    expect(lines).toEqual([
      '{"time":"1970-01-01T00:00:00.000Z","level":"error","event":"error.uncaught",' +
        '"fields":{"origin":"uncaught_exception","errorClass":"type_error"}}',
    ]);
    expect(lines.join()).not.toContain(CANARY);
    expect(lines.join()).not.toContain("example.invalid");
    expect(lines.join()).not.toContain("3f0e7c0a");
    expect(lines.join()).not.toContain("uncaught.test");
  });

  it("gives one line and one alarm for the same error a hundred times, then the count", () => {
    const { lines, raised, capture } = recorder();
    for (let i = 0; i < 100; i++) capture.capture("unhandled_rejection", new RangeError(`n ${i}`));
    expect(lines).toHaveLength(1);
    expect(raised).toEqual([{ origin: "unhandled_rejection", errorClass: "range_error" }]);
    capture.flush();
    expect(parsed(lines)[1]).toMatchObject({
      event: "error.uncaught_repeated",
      fields: { origin: "unhandled_rejection", errorClass: "range_error", repeats: 99 },
    });
    capture.flush();
    expect(lines).toHaveLength(2);
  });

  it("keeps another class and another origin apart, and opens a new group after the window", () => {
    const { lines, raised, capture, advance } = recorder();
    capture.capture("uncaught_exception", new TypeError("a"));
    capture.capture("uncaught_exception", new RangeError("b"));
    capture.capture("unhandled_rejection", new TypeError("c"));
    expect(raised).toHaveLength(3);
    capture.capture("uncaught_exception", new TypeError("d"));
    advance(1000);
    expect(capture.capture("uncaught_exception", new TypeError("e"))).toBe(true);
    expect(raised).toHaveLength(4);
    expect(parsed(lines).map((line) => line.event)).toEqual([
      "error.uncaught",
      "error.uncaught",
      "error.uncaught",
      "error.uncaught_repeated",
      "error.uncaught",
    ]);
  });

  it("still writes the line when the alarm cannot be raised", () => {
    const lines: string[] = [];
    const capture = createUncaughtCapture({
      log: createLogger((_level, line) => lines.push(line)),
      raise: () => {
        throw new Error("no alarm");
      },
    });
    expect(() => capture.capture("uncaught_exception", new Error("x"))).not.toThrow();
    expect(lines).toHaveLength(1);
  });
});

describe("errorClassOf", () => {
  it("names the class without reading the message", () => {
    expect(errorClassOf(new TypeError("x"))).toBe("type_error");
    expect(errorClassOf(new RangeError("x"))).toBe("range_error");
    expect(errorClassOf(new ReferenceError("x"))).toBe("reference_error");
    expect(errorClassOf(new SyntaxError("x"))).toBe("syntax_error");
    expect(errorClassOf(Object.assign(new Error("x"), { code: "23505", severity: "ERROR" }))).toBe(
      "database_error",
    );
    expect(errorClassOf(Object.assign(new Error("x"), { code: "ETIMEDOUT" }))).toBe("timeout");
    expect(errorClassOf(Object.assign(new Error("x"), { name: "TimeoutError" }))).toBe("timeout");
    expect(errorClassOf(Object.assign(new Error("x"), { code: "23505" }))).toBe("other");
    for (const value of [new Error("x"), "text", 7, null, undefined, {}]) {
      expect(errorClassOf(value)).toBe("other");
    }
  });

  it("never throws and never runs code of the value", () => {
    let ran = 0;
    const getter = Object.defineProperty({}, "code", {
      get: () => {
        ran += 1;
        return "ETIMEDOUT";
      },
    });
    const hostile = new Proxy(
      {},
      {
        getOwnPropertyDescriptor: () => {
          throw new Error("trap");
        },
        getPrototypeOf: () => {
          throw new Error("trap");
        },
      },
    );
    expect(errorClassOf(getter)).toBe("other");
    expect(errorClassOf(hostile)).toBe("other");
    expect(ran).toBe(0);
  });

  it("uses exactly the classes of error.unexpected in the catalogue", () => {
    const spec = EVENT_CATALOG["error.unexpected"].fields.errorClass;
    expect(spec.kind === "code" ? spec.values : []).toEqual([...UNCAUGHT_ERROR_CLASSES]);
  });
});

describe("installUncaughtCapture", () => {
  it("captures both events, writes the line before it exits 1, and stops when asked", () => {
    const order: string[] = [];
    const capture = createUncaughtCapture({
      log: createLogger((_level, line) =>
        order.push((JSON.parse(line) as { event: string }).event),
      ),
    });
    const target = new EventEmitter();
    const stop = installUncaughtCapture(target, {
      capture,
      exit: (code) => order.push(`exit ${code}`),
    });
    target.emit("uncaughtException", new TypeError(CANARY));
    target.emit("unhandledRejection", CANARY);
    expect(order).toEqual(["error.uncaught", "exit 1", "error.uncaught", "exit 1"]);
    stop();
    expect(target.listenerCount("uncaughtException")).toBe(0);
    expect(target.listenerCount("unhandledRejection")).toBe(0);
  });
});

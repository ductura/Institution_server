import { EventEmitter } from "node:events";

import { describe, expect, it } from "vitest";

import { CANARY } from "./invented.fixture.ts";
import {
  createLogger,
  createUncaughtCapture,
  errorClassOf,
  errorSiteOf,
  siteOfFrames,
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
// Errors made on one line each, so their place is known and differs.
const here = <E extends Error>(make: new (message: string) => E, message: string): E =>
  new make(message);
const elsewhere = (message: string): TypeError => new TypeError(message);
const HERE = /^server\/log\/uncaught\.test\.ts:\d+$/;
const parsed = (lines: string[]) =>
  lines.map((line) => JSON.parse(line) as { event: string; fields: Record<string, unknown> });

describe("createUncaughtCapture", () => {
  it("writes one line of closed codes and a place, and nothing else of the error", () => {
    const { lines, capture } = recorder();
    const error = here(TypeError, `${CANARY} ana.izmisljena@student.example.invalid`);
    Object.assign(error, { userId: "3f0e7c0a-5b1d-4c7e-9a52-0d6f1b2c3d4e", body: CANARY });
    expect(capture.capture("uncaught_exception", error)).toBe(true);
    expect(lines).toHaveLength(1);
    const [line] = parsed(lines);
    expect(Object.keys(line!)).toEqual(["time", "level", "event", "fields"]);
    expect(line!.event).toBe("error.uncaught");
    expect(Object.keys(line!.fields)).toEqual(["origin", "errorClass", "site"]);
    expect(line!.fields).toMatchObject({ origin: "uncaught_exception", errorClass: "type_error" });
    expect(line!.fields.site).toMatch(HERE);
    expect(lines.join()).not.toContain(CANARY);
    expect(lines.join()).not.toContain("example.invalid");
    expect(lines.join()).not.toContain("3f0e7c0a");
    expect(lines.join()).not.toContain("/home");
  });

  it("gives one line and one alarm for the same error a hundred times, then the count", () => {
    const { lines, raised, capture } = recorder();
    for (let i = 0; i < 100; i++)
      capture.capture("unhandled_rejection", here(RangeError, `n ${i}`));
    expect(lines).toHaveLength(1);
    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({ origin: "unhandled_rejection", errorClass: "range_error" });
    capture.flush();
    expect(parsed(lines)[1]).toMatchObject({
      event: "error.uncaught_repeated",
      fields: { origin: "unhandled_rejection", errorClass: "range_error", repeats: 99 },
    });
    expect(parsed(lines)[1]!.fields.site).toBe(raised[0]!.site);
    capture.flush();
    expect(lines).toHaveLength(2);
  });

  it("keeps another class and another origin apart, and opens a new group after the window", () => {
    const { lines, raised, capture, advance } = recorder();
    capture.capture("uncaught_exception", here(TypeError, "a"));
    capture.capture("uncaught_exception", here(RangeError, "b"));
    capture.capture("unhandled_rejection", here(TypeError, "c"));
    expect(raised).toHaveLength(3);
    capture.capture("uncaught_exception", here(TypeError, "d"));
    advance(1000);
    expect(capture.capture("uncaught_exception", here(TypeError, "e"))).toBe(true);
    expect(raised).toHaveLength(4);
    expect(parsed(lines).map((line) => line.event)).toEqual([
      "error.uncaught",
      "error.uncaught",
      "error.uncaught",
      "error.uncaught_repeated",
      "error.uncaught",
    ]);
  });

  it("keeps the same class thrown at another place apart", () => {
    const { raised, capture } = recorder();
    capture.capture("uncaught_exception", here(TypeError, "a"));
    capture.capture("uncaught_exception", elsewhere("a"));
    capture.capture("uncaught_exception", here(TypeError, "a"));
    expect(raised).toHaveLength(2);
    expect(raised[0]!.site).toMatch(HERE);
    expect(raised[1]!.site).toMatch(HERE);
    expect(raised[1]!.site).not.toBe(raised[0]!.site);
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

describe("siteOfFrames", () => {
  const frame = (file: string | null, line: number | null = 42) => ({ file, line });

  it("is the first frame of this repository's code, without the folder above it", () => {
    expect(
      siteOfFrames([
        frame("node:internal/process/task_queues", 95),
        frame("/srv/app/node_modules/pg/lib/client.js", 12),
        frame(`file:///home/${CANARY}/server/evidence/commit.ts`),
        frame("/srv/app/server/http/app.ts", 9),
      ]),
    ).toBe("server/evidence/commit.ts:42");
    expect(siteOfFrames([frame("dist/server.js", 1200)])).toBe("dist/server.js:1200");
  });

  it("is unknown when no frame is ours, the path is not plain, or the line is not a line", () => {
    for (const frames of [
      [],
      [frame(null)],
      [frame("node:internal/timers")],
      [frame("/srv/app/node_modules/x/server/y.js")],
      [frame(`/srv/app/server/${CANARY} ana@example.invalid/y.ts`)],
      [frame("/srv/app/other/y.ts")],
      [frame("/srv/app/server/y.ts?q=1")],
      [frame("/srv/app/server/y.ts", null)],
      [frame("/srv/app/server/y.ts", 0)],
      [frame("/srv/app/server/y.ts", 1.5)],
    ]) {
      expect(siteOfFrames(frames)).toBe("unknown");
    }
  });
});

describe("errorSiteOf", () => {
  it("is the place a real error was made at", () => {
    expect(errorSiteOf(here(Error, "x"))).toMatch(HERE);
  });

  it("never takes a line of the message for a frame", () => {
    const error = here(Error, `${CANARY}\n    at server/confidential-work-title.ts:123:4`);
    expect(errorSiteOf(error)).toMatch(HERE);
    expect(errorSiteOf(error)).toBe("unknown");
  });

  it("runs no getter of the error: not message, not name, not a stack of its own", () => {
    let ran = 0;
    const message = Object.defineProperty(here(Error, "x"), "message", {
      get: () => {
        ran += 1;
        return CANARY;
      },
    });
    class Named extends Error {
      override get name(): string {
        ran += 1;
        return CANARY;
      }
    }
    const stack = Object.defineProperty(here(Error, "x"), "stack", {
      get: () => {
        ran += 1;
        return "    at server/a.ts:1:1";
      },
    });
    expect(errorSiteOf(message)).toMatch(HERE);
    expect(errorSiteOf(new Named("x"))).toMatch(HERE);
    expect(errorSiteOf(stack)).toBe("unknown");
    expect(ran).toBe(0);
  });

  it("is unknown for a stack that is already text, was replaced, or belongs to no error", () => {
    const read = here(Error, "x");
    void read.stack;
    const replaced = Object.defineProperty(here(Error, "x"), "stack", {
      value: "Error: x\n    at server/evidence/commit.ts:42:7",
    });
    for (const value of [read, replaced, Object.create(Error.prototype), "server/a.ts:1:1", null]) {
      expect(errorSiteOf(value)).toBe("unknown");
    }
  });

  it("leaves Error.prepareStackTrace as it found it", () => {
    const before = Object.getOwnPropertyDescriptor(Error, "prepareStackTrace");
    errorSiteOf(here(Error, "x"));
    expect(Object.getOwnPropertyDescriptor(Error, "prepareStackTrace")).toEqual(before);
    const own = (): string => "own";
    Error.prepareStackTrace = own;
    try {
      errorSiteOf(here(Error, "x"));
      expect(Error.prepareStackTrace).toBe(own);
    } finally {
      if (before === undefined) Reflect.deleteProperty(Error, "prepareStackTrace");
      else Object.defineProperty(Error, "prepareStackTrace", before);
    }
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

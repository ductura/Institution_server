import { EventEmitter } from "node:events";

import { describe, expect, it } from "vitest";

import { CANARY } from "./invented.fixture.ts";
import {
  createLogger,
  createUncaughtCapture,
  errorClassOf,
  errorSiteOf,
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
/** An error whose stack is fixed text, with the canary in its message line. */
function thrownAt<E extends Error>(error: E, ...frames: string[]): E {
  const stack = [`${error.name}: ${CANARY}`, ...frames.map((frame) => `    at ${frame}`)].join(
    "\n",
  );
  return Object.defineProperty(error, "stack", { value: stack });
}
const COMMIT = "commit (file:///srv/app/server/evidence/commit.ts:42:7)";
const parsed = (lines: string[]) =>
  lines.map((line) => JSON.parse(line) as { event: string; fields: Record<string, unknown> });

describe("createUncaughtCapture", () => {
  it("writes one line of closed codes and nothing of the error itself", () => {
    const { lines, capture } = recorder();
    const error = thrownAt(
      new TypeError(`${CANARY} ana.izmisljena@student.example.invalid`),
      COMMIT,
    );
    Object.assign(error, { userId: "3f0e7c0a-5b1d-4c7e-9a52-0d6f1b2c3d4e", body: CANARY });
    expect(capture.capture("uncaught_exception", error)).toBe(true);
    expect(lines).toEqual([
      '{"time":"1970-01-01T00:00:00.000Z","level":"error","event":"error.uncaught",' +
        '"fields":{"origin":"uncaught_exception","errorClass":"type_error",' +
        '"site":"server/evidence/commit.ts:42"}}',
    ]);
    expect(lines.join()).not.toContain(CANARY);
    expect(lines.join()).not.toContain("example.invalid");
    expect(lines.join()).not.toContain("3f0e7c0a");
    expect(lines.join()).not.toContain("/srv/app");
  });

  it("gives one line and one alarm for the same error a hundred times, then the count", () => {
    const { lines, raised, capture } = recorder();
    for (let i = 0; i < 100; i++) {
      capture.capture("unhandled_rejection", thrownAt(new RangeError(`n ${i}`), COMMIT));
    }
    expect(lines).toHaveLength(1);
    expect(raised).toEqual([
      {
        origin: "unhandled_rejection",
        errorClass: "range_error",
        site: "server/evidence/commit.ts:42",
      },
    ]);
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
    capture.capture("uncaught_exception", thrownAt(new TypeError("a"), COMMIT));
    capture.capture("uncaught_exception", thrownAt(new RangeError("b"), COMMIT));
    capture.capture("unhandled_rejection", thrownAt(new TypeError("c"), COMMIT));
    expect(raised).toHaveLength(3);
    capture.capture("uncaught_exception", thrownAt(new TypeError("d"), COMMIT));
    advance(1000);
    expect(capture.capture("uncaught_exception", thrownAt(new TypeError("e"), COMMIT))).toBe(true);
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
    capture.capture("uncaught_exception", thrownAt(new TypeError("a"), COMMIT));
    capture.capture(
      "uncaught_exception",
      thrownAt(new TypeError("a"), "x (/srv/app/server/http/app.ts:9:1)"),
    );
    capture.capture("uncaught_exception", thrownAt(new TypeError("a"), COMMIT));
    expect(raised.map((group) => group.site)).toEqual([
      "server/evidence/commit.ts:42",
      "server/http/app.ts:9",
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

describe("errorSiteOf", () => {
  it("is the first frame of this repository's code, without the message or the folder above", () => {
    const error = thrownAt(
      new Error("x"),
      "node:internal/process/task_queues:95:5",
      "run (/srv/app/node_modules/pg/lib/client.js:12:3)",
      `${CANARY} (file:///home/${CANARY}/server/evidence/commit.ts:42:7)`,
      "later (/srv/app/server/http/app.ts:9:1)",
    );
    expect(errorSiteOf(error)).toBe("server/evidence/commit.ts:42");
    expect(errorSiteOf(thrownAt(new Error("x"), "dist/server.js:1200:15"))).toBe(
      "dist/server.js:1200",
    );
    expect(errorSiteOf(new Error("real"))).toMatch(/^server\/log\/uncaught\.test\.ts:\d+$/);
  });

  it("is unknown when no frame is ours, the path is not plain, or the value is not an error", () => {
    for (const frame of [
      "node:internal/timers:1:1",
      "f (/srv/app/node_modules/x/server/y.js:1:1)",
      `f (/srv/app/server/${CANARY} ana@example.invalid/y.ts:1:1)`,
      "f (/srv/app/other/y.ts:1:1)",
      "f (/srv/app/server/y.ts:1:1) trailing",
    ]) {
      expect(errorSiteOf(thrownAt(new Error("x"), frame))).toBe("unknown");
    }
    const messageOnly = Object.defineProperty(new Error("x"), "stack", {
      value: "Error: at server/evidence/commit.ts:42:7",
    });
    expect(errorSiteOf(messageOnly)).toBe("unknown");
    for (const value of ["server/a.ts:1:1", null, { stack: "    at server/a.ts:1:1" }]) {
      expect(errorSiteOf(value)).toBe("unknown");
    }
  });

  it("never runs a getter of the value", () => {
    let ran = 0;
    const error = Object.defineProperty(new Error("x"), "stack", {
      get: () => {
        ran += 1;
        return "    at server/a.ts:1:1";
      },
    });
    expect(errorSiteOf(error)).toBe("unknown");
    expect(ran).toBe(0);
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

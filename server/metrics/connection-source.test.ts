// DAN-834-4a: the database connection source on invented health reports.
// Criterion: a connection sample carries no connection string, user or error
// text. CANARY is an invented password and USER an invented login; neither is
// ever dialled.
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";

import { createConnectionSource } from "./connection-source.ts";
import type { MetricSample } from "./sample-writer.ts";

const CANARY = "lozinka-canary-8Hq3";
const USER = "korisnik-canary";
const URL_TEXT = `postgres://${USER}:${CANARY}@db.invalid:5432/ductura_main`;

const sample = (database: "main" | "logs" | "legal", value: 0 | 1) => ({
  metric: "database_connections",
  value,
  labels: { database },
});
const ALL_DOWN = [sample("main", 0), sample("logs", 0), sample("legal", 0)];

async function samplesOf(health: () => unknown): Promise<readonly MetricSample[]> {
  const samples = await createConnectionSource(health)();
  // Nothing from the report reaches a sample: exact keys and no canary.
  const text = JSON.stringify(samples);
  expect(text).not.toContain(CANARY);
  expect(text).not.toContain(USER);
  expect(text).not.toContain("db.invalid");
  for (const one of samples) {
    expect(Object.keys(one)).toEqual(["metric", "value", "labels"]);
    expect(Object.keys(one.labels ?? {})).toEqual(["database"]);
    expect(Object.isFrozen(one)).toBe(true);
    expect(Object.isFrozen(one.labels)).toBe(true);
  }
  return samples;
}

const report = (main: unknown) => ({ main, logs: "ok", legal: "ok" });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("connection source: values that are not available", () => {
  const values: [string, unknown][] = [
    ["connection string", URL_TEXT],
    ["error with the string", new Error(`connect failed for ${URL_TEXT}`)],
    ["leading space", " ok"],
    ["trailing LF", "ok\n"],
    ["CRLF", "ok\r\n"],
    ["tab", "ok\t"],
    ["NBSP", "ok "],
    ["DEL", "ok\u007f"],
    ["upper case", "OK"],
    ["String object", new String("ok")],
    ["true", true],
    ["one", 1],
    ["undefined", undefined],
    ["null", null],
    ["nedostupno", "nedostupno"],
  ];

  it.each(values)("%s gives 0", async (_name, value) => {
    expect(await samplesOf(() => report(value))).toEqual([
      sample("main", 0),
      sample("logs", 1),
      sample("legal", 1),
    ]);
  });

  it("ignores extra keys that carry the string, user or error", async () => {
    const extra = JSON.parse(
      `{"main":"ok","logs":"ok","legal":"ok","url":"${URL_TEXT}","user":"${USER}",` +
        `"error":"${CANARY}","__proto__":{"main":"x"},"toString":"${CANARY}"}`,
    ) as unknown;
    expect(await samplesOf(() => extra)).toEqual([
      sample("main", 1),
      sample("logs", 1),
      sample("legal", 1),
    ]);
  });

  it("never calls a getter and never reads an inherited value", async () => {
    const getter = vi.fn(() => "ok");
    const withGetter = Object.defineProperty({ logs: "ok", legal: "ok" }, "main", {
      get: getter,
      enumerable: true,
    });
    expect(await samplesOf(() => withGetter)).toEqual([
      sample("main", 0),
      sample("logs", 1),
      sample("legal", 1),
    ]);
    expect(getter).not.toHaveBeenCalled();
    const inherited = Object.assign(Object.create({ main: "ok" }) as object, {
      logs: "ok",
      legal: "ok",
    });
    expect((await samplesOf(() => inherited))[0]).toEqual(sample("main", 0));
  });

  it("does not read a polluted Object.prototype", async () => {
    const proto = Object.prototype as Record<string, unknown>;
    proto.main = "ok";
    try {
      expect(await samplesOf(() => ({}))).toEqual(ALL_DOWN);
    } finally {
      delete proto.main;
    }
  });

  it("gives all 0 when a trap of the report throws", async () => {
    const trap = () => {
      throw new Error(CANARY);
    };
    const throwing = new Proxy({}, { getOwnPropertyDescriptor: trap, get: trap });
    expect(await samplesOf(() => throwing)).toEqual(ALL_DOWN);
  });
});

describe("connection source: a failing health check", () => {
  const failures: [string, () => unknown][] = [
    [
      "throws",
      () => {
        throw new Error(URL_TEXT);
      },
    ],
    [
      "rejects with cause",
      () => Promise.reject(new Error(`no ${USER}`, { cause: new Error(CANARY) })),
    ],
    ["gives a string", () => URL_TEXT],
    ["gives null", () => null],
    ["gives an array", () => [URL_TEXT]],
    [
      "gives a thenable that throws",
      () => ({
        then() {
          throw new Error(CANARY);
        },
      }),
    ],
  ];

  it.each(failures)("%s: all 0, settles, nothing unhandled", async (_name, health) => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      expect(await samplesOf(health)).toEqual(ALL_DOWN);
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});

describe("connection source: the report", () => {
  it("is refused when health is not a function", () => {
    for (const health of [undefined, null, {}, "health"]) {
      expect(() => createConnectionSource(health as never)).toThrow(RangeError);
    }
  });

  it("gives 1 for ok, 0 for unavailable and no sample for a database not set up", async () => {
    const health = vi.fn(async () => ({
      main: "ok",
      logs: "nedostupno",
      legal: "nije_konfigurirano",
    }));
    expect(await samplesOf(health)).toEqual([sample("main", 1), sample("logs", 0)]);
    expect(health).toHaveBeenCalledTimes(1);
  });

  it("gives every database in order when all are ok", async () => {
    expect(await samplesOf(() => ({ legal: "ok", logs: "ok", main: "ok" }))).toEqual([
      sample("main", 1),
      sample("logs", 1),
      sample("legal", 1),
    ]);
  });

  it("is the input of the metric_sample writer", () => {
    expectTypeOf(createConnectionSource(() => ({}))).returns.resolves.toMatchTypeOf<
      readonly MetricSample[]
    >();
  });
});

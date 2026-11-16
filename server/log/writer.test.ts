import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CANARY } from "./invented.fixture.ts";
import {
  CATALOG_ERROR_CODES,
  createLogger,
  createLogWriter,
  EVENT_CATALOG,
  EVENT_KINDS,
  type EventKind,
  type FieldSpec,
  LOG_WRITER_ERROR_CODES,
  type LogEvent,
  type LogStore,
} from "./index.ts";

// S-1K.3-a (DAN-807): the log service. Invented values only; CANARY is the
// marked value that must never reach a stored row or a console line.

const REQUEST_ID = "3f2a7c1e-9b4d-4e8a-a1c2-0d5e6f708192";
const OTHER_ID = "0b1c2d3e-4f50-4617-8293-a4b5c6d7e8f9";
const ROUTE = "/api/v1/live/{documentId}";
const ROUTES: ReadonlySet<string> = new Set([ROUTE]);
const TIME = "2026-11-16T09:30:00.000Z";
const SPECS = EVENT_CATALOG as Record<
  EventKind,
  { actors: readonly string[]; fields: Record<string, FieldSpec> }
>;

function validValue(spec: FieldSpec): string | number | boolean {
  switch (spec.kind) {
    case "code":
      return spec.values[0] ?? "";
    case "int":
      return spec.max;
    case "flag":
      return false;
    case "id":
      return OTHER_ID;
    case "version":
      return "1.4.0";
    case "route":
      return ROUTE;
  }
}

function validRecord(kind: EventKind): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(SPECS[kind].fields)) fields[name] = validValue(spec);
  return {
    time: TIME,
    event: kind,
    requestId: REQUEST_ID,
    accountKind: SPECS[kind].actors[0],
    fields,
  };
}

type Appended = { kind: string; payload: unknown };

function memoryStore(): LogStore & { rows: Appended[] } {
  const rows: Appended[] = [];
  return {
    rows,
    append: (kind, payload) => {
      rows.push({ kind, payload: JSON.parse(JSON.stringify(payload)) as unknown });
      return Promise.resolve();
    },
  };
}

function capture(): { lines: string[]; fallback: LogEvent } {
  const lines: string[] = [];
  return {
    lines,
    fallback: createLogger(
      (_level, line) => lines.push(line),
      () => new Date(0),
    ),
  };
}

describe("createLogWriter", () => {
  afterEach(() => vi.restoreAllMocks());

  it("stores every kind of the catalog once, as the checked record", async () => {
    const store = memoryStore();
    const { lines, fallback } = capture();
    const write = createLogWriter({ store, routes: ROUTES, fallback });
    for (const kind of EVENT_KINDS) {
      const record = validRecord(kind);
      const result = await write(record);
      expect(result, kind).toEqual({ ok: true, value: record });
      expect(store.rows.at(-1), kind).toEqual({ kind, payload: record });
    }
    expect(store.rows).toHaveLength(EVENT_KINDS.length);
    expect(lines).toEqual([]);
  });

  it("stores no refused record and logs only its code", async () => {
    const store = memoryStore();
    const { lines, fallback } = capture();
    const write = createLogWriter({ store, routes: ROUTES, fallback });
    const base = validRecord("authz.denied");
    const refused: [unknown, string][] = [
      [{ ...base, event: `authz.${CANARY}` }, "UNKNOWN_EVENT"],
      [{ ...base, note: CANARY }, "UNKNOWN_KEY"],
      [{ ...base, fields: { ...(base.fields as object), note: CANARY } }, "UNKNOWN_FIELD"],
      [{ ...base, requestId: CANARY }, "BAD_REQUEST_ID"],
      [{ ...base, accountKind: CANARY }, "UNKNOWN_ACCOUNT_KIND"],
      [CANARY, "NOT_A_PLAIN_OBJECT"],
    ];
    for (const [input, code] of refused) {
      const result = await write(input);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(code);
        expect(CATALOG_ERROR_CODES).toContain(result.error.code);
      }
    }
    expect(store.rows).toEqual([]);
    expect(lines).toHaveLength(refused.length);
    for (const line of lines) {
      const parsed = JSON.parse(line) as { event: string; fields: object };
      expect(parsed.event).toBe("log_refused");
      expect(Object.keys(parsed.fields)).toEqual(["code"]);
    }
    expect(lines.join("")).not.toContain("kanarinac");
  });

  it("refuses every record when the inventory is not a real Set", async () => {
    const store = memoryStore();
    const { fallback } = capture();
    const routes = { has: () => true } as unknown as ReadonlySet<string>;
    const result = await createLogWriter({ store, routes, fallback })(
      validRecord("traffic.request"),
    );
    expect(result).toMatchObject({ ok: false, error: { code: "BAD_OPTIONS" } });
    expect(store.rows).toEqual([]);
  });

  const failingStores: [string, LogStore["append"]][] = [
    [
      "throws",
      () => {
        throw new Error(`insert failed: ${CANARY}`);
      },
    ],
    ["rejects", () => Promise.reject(new Error(`duplicate key ${CANARY}`))],
    ["rejects with a non-error", () => Promise.reject(CANARY as unknown as Error)],
    [
      "returns a thenable whose then throws",
      () => ({
        get then(): never {
          throw new Error(CANARY);
        },
      }),
    ],
  ];

  for (const [name, append] of failingStores) {
    it(`answers LOG_STORE_FAILED and never throws when the store ${name}`, async () => {
      const { lines, fallback } = capture();
      const write = createLogWriter({ store: { append }, routes: ROUTES, fallback });
      await expect(write(validRecord("authn.logout"))).resolves.toEqual({
        ok: false,
        error: { code: "LOG_STORE_FAILED", messageKey: "logWriter.log_store_failed" },
      });
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0] ?? "")).toMatchObject({
        event: "log_store_failed",
        fields: { code: "LOG_STORE_FAILED" },
      });
      expect(lines.join("")).not.toContain("kanarinac");
    });
  }

  it("accepts a store whose append returns no promise", async () => {
    const rows: unknown[] = [];
    const write = createLogWriter({
      store: { append: (_kind, payload) => rows.push(payload) },
      routes: ROUTES,
      fallback: capture().fallback,
    });
    expect((await write(validRecord("authn.logout"))).ok).toBe(true);
    expect(rows).toHaveLength(1);
  });

  it("never throws when the input or the fallback throws", async () => {
    const throwing: LogEvent = () => {
      throw new Error(CANARY);
    };
    const write = createLogWriter({ store: memoryStore(), routes: ROUTES, fallback: throwing });
    const getter = Object.defineProperty({}, "time", {
      enumerable: true,
      get(): never {
        throw new Error(CANARY);
      },
    });
    const proxy = new Proxy(
      {},
      {
        ownKeys(): never {
          throw new Error(CANARY);
        },
      },
    );
    for (const input of [getter, proxy, null, undefined])
      await expect(write(input)).resolves.toMatchObject({ ok: false });
    await expect(
      createLogWriter({
        store: {
          append: () => {
            throw new Error(CANARY);
          },
        },
        routes: ROUTES,
        fallback: throwing,
      })(validRecord("authn.logout")),
    ).resolves.toMatchObject({ ok: false, error: { code: "LOG_STORE_FAILED" } });
  });

  it("writes the fallback to the console by default, without the canary", async () => {
    const spies = (["error", "warn", "log", "info", "debug"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    );
    const write = createLogWriter({
      store: { append: () => Promise.reject(new Error(CANARY)) },
      routes: ROUTES,
    });
    await write({ ...validRecord("authn.logout"), note: CANARY });
    await write(validRecord("authn.logout"));
    const printed = JSON.stringify(spies.map((spy) => spy.mock.calls));
    expect(printed).toContain("log_refused");
    expect(printed).toContain("log_store_failed");
    expect(printed).not.toContain("kanarinac");
  });

  it("has a Croatian text for every code it answers with", () => {
    const texts = JSON.parse(
      readFileSync(new URL("../../locales/hr.json", import.meta.url), "utf8"),
    ) as { logWriter: Record<string, string> };
    expect(Object.keys(texts.logWriter).sort()).toEqual(
      LOG_WRITER_ERROR_CODES.map((code) => code.toLowerCase()).sort(),
    );
  });
});

describe("createLogWriter with a redact that changes a checked record", () => {
  afterEach(() => {
    vi.doUnmock("./redact.ts");
    vi.resetModules();
  });

  it("stores nothing and answers LOG_REDACTED", async () => {
    // No value the catalog admits is changed by redact today; this stands in
    // for a future gap between the two nets.
    vi.resetModules();
    vi.doMock("./redact.ts", async (original) => ({
      ...(await original<typeof import("./redact.ts")>()),
      redact: (value: unknown) => ({ ...(value as object), fields: { x: "[redacted]" } }),
    }));
    const { createLogWriter: fresh } = await import("./writer.ts");
    const store = memoryStore();
    const { lines, fallback } = capture();
    const result = await fresh({ store, routes: ROUTES, fallback })(validRecord("authn.logout"));
    expect(result).toEqual({
      ok: false,
      error: { code: "LOG_REDACTED", messageKey: "logWriter.log_redacted" },
    });
    expect(store.rows).toEqual([]);
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({
      event: "log_refused",
      fields: { code: "LOG_REDACTED" },
    });
  });
});

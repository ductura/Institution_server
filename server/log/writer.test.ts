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
  LOG_MAX_PENDING,
  LOG_WRITE_DEADLINE_MS,
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
// The route templates of server/contracts ROUTES at DAN-807, written out
// because the area log may not import contracts (docs/server-map.md §2).
const INVENTORY = [
  "/api/v1/health",
  "/api/v1/ready",
  "/api/v1/status",
  "/api/v1/auth/login",
  "/api/v1/auth/callback",
  "/api/v1/auth/logout",
  "/api/v1/auth/logout-all",
  "/api/v1/auth/backchannel-logout",
  "/api/v1/profile/interface-locale",
  "/api/v1/evidence/open",
  "/api/v1/evidence/commit",
  "/api/v1/student/assignments",
  "/api/v1/live/{documentId}",
  "/api/v1/settings/{level}/{settingKey}/history",
];
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
    case "routeOrNone":
      return ROUTE;
    case "ip":
      return "2001:db8::7";
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

  it("stores a route field of every route of the server's inventory unchanged", async () => {
    // A long template such as /api/v1/evidence/commit has the shape redact
    // takes for a token; the writer must store it as checked (self-attack).
    const paths = INVENTORY;
    const store = memoryStore();
    const { lines, fallback } = capture();
    const write = createLogWriter({ store, routes: new Set(paths), fallback });
    for (const kind of EVENT_KINDS) {
      const routeFields = Object.entries(SPECS[kind].fields).filter(([, s]) => s.kind === "route");
      for (const path of routeFields.length > 0 ? paths : []) {
        const record = validRecord(kind);
        const fields = record.fields as Record<string, unknown>;
        for (const [name] of routeFields) fields[name] = path;
        expect(await write(record), `${kind} ${path}`).toEqual({ ok: true, value: record });
        expect(store.rows.at(-1), `${kind} ${path}`).toEqual({ kind, payload: record });
      }
    }
    expect(store.rows.length).toBeGreaterThanOrEqual(paths.length);
    expect(lines).toEqual([]);
  });

  it("stores a traffic record with its client IP and none unchanged (DAN-831-1)", async () => {
    // `ip` is a key redact drops; the catalog admitted only an address or none.
    const store = memoryStore();
    const { lines, fallback } = capture();
    const write = createLogWriter({ store, routes: ROUTES, fallback });
    for (const [ip, route] of [
      ["192.0.2.1", ROUTE],
      ["2001:db8::7", "none"],
      ["none", "none"],
    ]) {
      const record = validRecord("traffic.request");
      Object.assign(record.fields as object, { ip, route });
      expect(await write(record), ip).toEqual({ ok: true, value: record });
      expect(store.rows.at(-1), ip).toEqual({ kind: "traffic.request", payload: record });
    }
    expect(lines).toEqual([]);
  });

  it("keeps the client IP out of the fallback line when the store fails", async () => {
    const { lines, fallback } = capture();
    const store = { append: () => Promise.reject(new Error("down")) };
    const record = validRecord("traffic.request");
    Object.assign(record.fields as object, { ip: "192.0.2.1" });
    const result = await createLogWriter({ store, routes: ROUTES, fallback })(record);
    expect(result).toMatchObject({ ok: false, error: { code: "LOG_STORE_FAILED" } });
    expect(lines).toHaveLength(1);
    expect(lines.join("")).not.toContain("192.0.2.1");
  });

  it("still refuses a route field that is not in the inventory", async () => {
    const store = memoryStore();
    const write = createLogWriter({ store, routes: ROUTES, fallback: capture().fallback });
    const record = validRecord("traffic.request");
    const fields = record.fields as Record<string, unknown>;
    for (const value of [`/api/v1/${CANARY}`, `${ROUTE}?x=${CANARY}`, `${ROUTE} `]) {
      fields.route = value;
      expect(await write(record)).toMatchObject({ ok: false, error: { code: "BAD_FIELD_VALUE" } });
    }
    expect(store.rows).toEqual([]);
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

// S-1K.3-b (DAN-812, plan ductura/server#109): a slow, hanging or crowded log
// database never holds a write past its deadline, and a record it did not
// take is in the fallback line, never dropped silently.
describe("createLogWriter when the log database is slow or down", () => {
  afterEach(() => vi.useRealTimers());

  const hanging = (): LogStore & { calls: number; release: () => void } => {
    let release = () => {};
    const store = {
      calls: 0,
      release: () => release(),
      append: () => {
        store.calls += 1;
        return new Promise<void>((resolve) => (release = resolve));
      },
    };
    return store;
  };
  const parsed = (line: string | undefined) =>
    JSON.parse(line ?? "") as { event: string; fields: { code: string; record?: unknown } };

  it("has the agreed defaults", () => {
    expect([LOG_WRITE_DEADLINE_MS, LOG_MAX_PENDING]).toEqual([1_000, 64]);
  });

  it("answers LOG_STORE_TIMEOUT at the deadline and puts the record in the fallback (A2)", async () => {
    vi.useFakeTimers();
    const { lines, fallback } = capture();
    const store = hanging();
    const write = createLogWriter({ store, routes: ROUTES, fallback, deadlineMs: 50 });
    let result: unknown;
    void write(validRecord("authn.logout")).then((value) => (result = value));
    await vi.advanceTimersByTimeAsync(49);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toEqual({
      ok: false,
      error: { code: "LOG_STORE_TIMEOUT", messageKey: "logWriter.log_store_timeout" },
    });
    expect(lines).toHaveLength(1);
    expect(parsed(lines[0])).toEqual({
      time: new Date(0).toISOString(),
      level: "error",
      event: "log_store_failed",
      fields: { code: "LOG_STORE_TIMEOUT", record: validRecord("authn.logout") },
    });
  });

  it("keeps one outcome when the store settles after the deadline (A3)", async () => {
    vi.useFakeTimers();
    for (const late of ["resolves", "rejects"] as const) {
      const { lines, fallback } = capture();
      let settle = () => {};
      const append = () =>
        new Promise<void>((resolve, reject) => {
          settle = () => (late === "resolves" ? resolve() : reject(new Error(CANARY)));
        });
      const write = createLogWriter({ store: { append }, routes: ROUTES, fallback, deadlineMs: 5 });
      const pending = write(validRecord("authn.logout"));
      await vi.advanceTimersByTimeAsync(5);
      await expect(pending).resolves.toMatchObject({ error: { code: "LOG_STORE_TIMEOUT" } });
      settle();
      await vi.advanceTimersByTimeAsync(0);
      expect(lines).toHaveLength(1);
      expect(lines.join("")).not.toContain("kanarinac");
    }
  });

  it("sends at most maxPending records to a hanging store; the rest go to the fallback (A4)", async () => {
    vi.useFakeTimers();
    const { lines, fallback } = capture();
    const store = hanging();
    const write = createLogWriter({ store, routes: ROUTES, fallback, maxPending: 2 });
    const first = [write(validRecord("authn.logout")), write(validRecord("authn.logout"))];
    await vi.advanceTimersByTimeAsync(0);
    await expect(write(validRecord("session.created"))).resolves.toEqual({
      ok: false,
      error: { code: "LOG_STORE_BUSY", messageKey: "logWriter.log_store_busy" },
    });
    expect(store.calls).toBe(2);
    expect(parsed(lines[0]).fields).toEqual({
      code: "LOG_STORE_BUSY",
      record: validRecord("session.created"),
    });
    // The deadline answers the callers, yet the places stay taken while the
    // store still holds the two writes.
    await vi.advanceTimersByTimeAsync(LOG_WRITE_DEADLINE_MS);
    for (const result of await Promise.all(first))
      expect(result).toMatchObject({ error: { code: "LOG_STORE_TIMEOUT" } });
    await expect(write(validRecord("authn.logout"))).resolves.toMatchObject({
      error: { code: "LOG_STORE_BUSY" },
    });
    expect(store.calls).toBe(2);
  });

  it("frees a place when the store settles, so writes reach it again (A5)", async () => {
    const rows: unknown[] = [];
    let down = true;
    const failures: (() => void)[] = [];
    const store: LogStore = {
      append: (_kind, payload) =>
        down
          ? new Promise<void>((_resolve, reject) => failures.push(() => reject(new Error(CANARY))))
          : Promise.resolve(void rows.push(payload)),
    };
    const write = createLogWriter({
      store,
      routes: ROUTES,
      fallback: capture().fallback,
      maxPending: 1,
    });
    const stuck = write(validRecord("authn.logout"));
    await expect(write(validRecord("authn.logout"))).resolves.toMatchObject({
      error: { code: "LOG_STORE_BUSY" },
    });
    for (const fail of failures) fail();
    await expect(stuck).resolves.toMatchObject({ error: { code: "LOG_STORE_FAILED" } });
    down = false;
    await expect(write(validRecord("authn.logout"))).resolves.toMatchObject({ ok: true });
    expect(rows).toHaveLength(1);
  });

  it("puts the record in the fallback when the store fails (A1), never the store's message", async () => {
    const { lines, fallback } = capture();
    const write = createLogWriter({
      store: { append: () => Promise.reject(new Error(CANARY)) },
      routes: ROUTES,
      fallback,
    });
    await write(validRecord("error.unexpected"));
    expect(parsed(lines[0]).fields).toEqual({
      code: "LOG_STORE_FAILED",
      record: validRecord("error.unexpected"),
    });
    expect(lines.join("")).not.toContain("kanarinac");
  });

  it("refuses a deadlineMs past what setTimeout keeps, which Node would make 1 ms (A7)", () => {
    const base = { store: memoryStore(), routes: ROUTES };
    expect(() => createLogWriter({ ...base, deadlineMs: 2 ** 31 })).toThrow(RangeError);
    expect(() => createLogWriter({ ...base, deadlineMs: 2 ** 31 - 1 })).not.toThrow();
  });

  it("puts a record with a route in the fallback without throwing or the canary (A13)", async () => {
    vi.useFakeTimers();
    const routes = new Set(INVENTORY);
    const record = {
      ...validRecord("traffic.rate_limited"),
      fields: { route: "/api/v1/evidence/commit", bucket: "per_address" },
    };
    const stores: [string, LogStore][] = [
      ["LOG_STORE_FAILED", { append: () => Promise.reject(new Error(CANARY)) }],
      ["LOG_STORE_TIMEOUT", hanging()],
    ];
    for (const [code, store] of stores) {
      const { lines, fallback } = capture();
      const write = createLogWriter({ store, routes, fallback, deadlineMs: 1, maxPending: 1 });
      const first = write(record);
      if (code === "LOG_STORE_TIMEOUT") {
        await expect(write(record)).resolves.toMatchObject({ error: { code: "LOG_STORE_BUSY" } });
      }
      await vi.advanceTimersByTimeAsync(1);
      await expect(first).resolves.toMatchObject({ error: { code } });
      const fallbackLines = lines.map(parsed);
      expect(fallbackLines.at(-1)?.fields).toMatchObject({
        code,
        record: { event: "traffic.rate_limited", fields: { bucket: "per_address" } },
      });
      for (const line of fallbackLines)
        expect((line.fields.record as { fields: { route: string } }).fields.route).toMatch(
          /^(\/api\/v1\/evidence\/commit|\[redacted\])$/u,
        );
      expect(lines.join("")).not.toContain("kanarinac");
    }
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])(
    "refuses deadlineMs and maxPending %s at creation (A7)",
    (value) => {
      const base = { store: memoryStore(), routes: ROUTES };
      expect(() => createLogWriter({ ...base, deadlineMs: value })).toThrow(RangeError);
      expect(() => createLogWriter({ ...base, maxPending: value })).toThrow(RangeError);
    },
  );

  it("never throws when the store hangs and the fallback throws (A8)", async () => {
    vi.useFakeTimers();
    const write = createLogWriter({
      store: hanging(),
      routes: ROUTES,
      fallback: () => {
        throw new Error(CANARY);
      },
      deadlineMs: 1,
      maxPending: 1,
    });
    const first = write(validRecord("authn.logout"));
    await expect(write(validRecord("authn.logout"))).resolves.toMatchObject({
      error: { code: "LOG_STORE_BUSY" },
    });
    await vi.advanceTimersByTimeAsync(1);
    await expect(first).resolves.toMatchObject({ error: { code: "LOG_STORE_TIMEOUT" } });
  });
});

describe("createLogWriter with a redact that changes a checked record", () => {
  afterEach(() => {
    vi.doUnmock("./redact.ts");
    vi.resetModules();
  });

  it("stores nothing and answers LOG_REDACTED", async () => {
    // Apart from route templates, no value the catalog admits is changed by
    // redact today; this stands in for a future gap between the two nets.
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

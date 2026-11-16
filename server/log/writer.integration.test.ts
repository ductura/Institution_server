import { createFakeLogDatabase, type FakeLogDatabase } from "@ductura/test-fakes";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { CANARY } from "./invented.fixture.ts";
import {
  createLogWriter,
  EVENT_CATALOG,
  EVENT_KINDS,
  type EventKind,
  type FieldSpec,
  type LogWriter,
} from "./index.ts";

// S-1K.3-a (DAN-807) canary: one invented marked value is pushed through every
// field of every event kind, every key of the record, and the store's own
// error message; it must reach neither a row of the fake log database
// (@ductura/test-fakes, PGlite) nor the console.

const REQUEST_ID = "3f2a7c1e-9b4d-4e8a-a1c2-0d5e6f708192";
const OTHER_ID = "0b1c2d3e-4f50-4617-8293-a4b5c6d7e8f9";
const ROUTE = "/api/v1/live/{documentId}";
const ROUTES: ReadonlySet<string> = new Set([ROUTE]);
const SPECS = EVENT_CATALOG as Record<
  EventKind,
  { actors: readonly string[]; fields: Record<string, FieldSpec> }
>;

function validValue(spec: FieldSpec): string | number | boolean {
  switch (spec.kind) {
    case "code":
      return spec.values[0] ?? "";
    case "int":
      return spec.min;
    case "flag":
      return true;
    case "id":
      return OTHER_ID;
    case "version":
      return "1.4.0";
    case "route":
      return ROUTE;
  }
}

function validRecord(kind: EventKind): Record<string, unknown> & { fields: object } {
  const fields: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(SPECS[kind].fields)) fields[name] = validValue(spec);
  return {
    time: "2026-11-16T09:30:00.000Z",
    event: kind,
    requestId: REQUEST_ID,
    accountKind: SPECS[kind].actors[0],
    fields,
  };
}

/** Every way the canary can be put into one record of `kind`. */
function poisoned(kind: EventKind): unknown[] {
  const base = validRecord(kind);
  const inputs: unknown[] = [
    { ...base, event: CANARY },
    { ...base, event: `${kind} ${CANARY}` },
    { ...base, time: CANARY },
    { ...base, requestId: CANARY },
    { ...base, accountKind: CANARY },
    { ...base, note: CANARY },
    { ...base, fields: { ...base.fields, note: CANARY } },
    { ...base, fields: { ...base.fields, password: CANARY } },
    { ...base, fields: CANARY },
  ];
  for (const name of Object.keys(base.fields)) {
    inputs.push({ ...base, fields: { ...base.fields, [name]: CANARY } });
    inputs.push({ ...base, fields: { ...base.fields, [name]: `${ROUTE}?x=${CANARY}` } });
    inputs.push({ ...base, fields: { ...base.fields, [name]: { text: CANARY } } });
    inputs.push({ ...base, fields: { ...base.fields, [name]: [CANARY] } });
  }
  return inputs;
}

describe("canary through the log service into the log database", () => {
  let database: FakeLogDatabase;
  let write: LogWriter;
  let printed: () => string;

  beforeAll(async () => {
    database = await createFakeLogDatabase();
    write = createLogWriter({ store: database, routes: ROUTES });
  });
  afterAll(() => database.close());
  afterEach(() => vi.restoreAllMocks());

  function captureConsole(): void {
    const spies = (["error", "warn", "log", "info", "debug"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    );
    printed = () => JSON.stringify(spies.map((spy) => spy.mock.calls));
  }

  it("stores a valid record of every kind, as checked", async () => {
    const before = (await database.entries()).length;
    for (const kind of EVENT_KINDS) expect((await write(validRecord(kind))).ok, kind).toBe(true);
    const rows = (await database.entries()).slice(before);
    expect(rows.map((row) => row.kind)).toEqual([...EVENT_KINDS]);
    for (const row of rows) expect(row.payload).toEqual(validRecord(row.kind as EventKind));
  });

  it("never lets the canary reach a row or the console", async () => {
    captureConsole();
    let refused = 0;
    for (const kind of EVENT_KINDS)
      for (const input of poisoned(kind)) {
        const result = await write(input);
        expect(result.ok, `${kind} ${JSON.stringify(input)}`).toBe(false);
        refused += 1;
      }
    expect(refused).toBeGreaterThan(EVENT_KINDS.length * 9);
    expect(JSON.stringify(await database.entries())).not.toContain("kanarinac");
    expect(printed()).toContain("log_refused");
    expect(printed()).not.toContain("kanarinac");
  });

  it("keeps the database's own error message out of the console", async () => {
    captureConsole();
    // A payload the database refuses: a NUL in a JSON text fails jsonb with a
    // message that would quote the value.
    const failing = createLogWriter({
      store: { append: (kind) => database.append(`${kind}`, `\u0000${CANARY}`) },
      routes: ROUTES,
    });
    expect(await failing(validRecord("authn.logout"))).toMatchObject({
      ok: false,
      error: { code: "LOG_STORE_FAILED" },
    });
    expect(printed()).toContain("log_store_failed");
    expect(printed()).not.toContain("kanarinac");
    expect(JSON.stringify(await database.entries())).not.toContain("kanarinac");
  });
});

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { SHARED_ERRORS } from "../../server/contracts/index.ts";
import { ERROR_CATALOG } from "../../server/http/index.ts";

// DAN-928: the error catalogue and SHARED_ERRORS as data in @ductura/contracts
// (errors/catalog.json), for clients that must not load server code. The file is
// server/contracts/routes/error-catalog.json, the one the server itself reads;
// this test reads it strictly and checks what the server built from it.
const FORMAT = "ductura-error-catalog-v1";
const CODE = /^[a-z][a-z0-9_]*$/u;
const KEY = /^[a-z][A-Za-z]*\.[a-z][A-Za-z0-9]*$/u;
type Entry = { status: number; code: string; messageKey: string };
type Catalog = { errors: Entry[]; shared: Entry[] };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
// Exactly these own keys: an extra, missing or inherited-name key fails.
const hasKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const own = Reflect.ownKeys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
};

function readEntries(raw: unknown, list: string): Entry[] | string {
  if (!Array.isArray(raw)) return `${list}: not an array`;
  const entries: Entry[] = [];
  for (const [at, item] of (raw as unknown[]).entries()) {
    if (!isObject(item) || !hasKeys(item, ["status", "code", "messageKey"]))
      return `${list}#${at}: wrong fields`;
    const { status, code, messageKey } = item;
    if (!Number.isInteger(status) || (status as number) < 100 || (status as number) > 599)
      return `${list}#${at}: bad status`;
    if (typeof code !== "string" || !CODE.test(code)) return `${list}#${at}: bad code`;
    if (typeof messageKey !== "string" || !KEY.test(messageKey)) return `${list}#${at}: bad key`;
    if (entries.some((entry) => entry.code === code)) return `${list}: duplicate ${code}`;
    entries.push({ status: status as number, code, messageKey });
  }
  return entries;
}

function readCatalog(raw: unknown): Catalog | string {
  if (!isObject(raw) || !hasKeys(raw, ["format", "errors", "shared"])) return "root";
  if (raw.format !== FORMAT) return "format";
  const errors = readEntries(raw.errors, "errors");
  if (typeof errors === "string") return errors;
  const shared = readEntries(raw.shared, "shared");
  if (typeof shared === "string") return shared;
  for (const entry of shared) {
    if (
      !errors.some(
        (e) =>
          e.code === entry.code && e.status === entry.status && e.messageKey === entry.messageKey,
      )
    )
      return `shared: ${entry.code} not in errors`;
  }
  return { errors, shared };
}

const SERVER: Catalog = {
  errors: ERROR_CATALOG.map(({ status, code, messageKey }) => ({ status, code, messageKey })),
  shared: SHARED_ERRORS.map(({ status, code, key }) => ({ status, code, messageKey: key })),
};
const FILE = readFileSync(
  new URL("../../server/contracts/routes/error-catalog.json", import.meta.url),
  "utf8",
);
const RAW = JSON.parse(FILE) as { format: string; errors: Entry[]; shared: Entry[] };
const copy = (): typeof RAW => structuredClone(RAW);

describe("error catalogue reader (negative cases)", () => {
  const entry = (patch: Record<string, unknown>): unknown => {
    const raw = copy() as unknown as { errors: Record<string, unknown>[] };
    raw.errors[0] = { ...raw.errors[0], ...patch };
    return raw;
  };
  const cases: [string, unknown, string][] = [
    ["extra root field", { ...copy(), extra: 1 }, "root"],
    ["missing root field", { format: FORMAT, errors: [] }, "root"],
    ["wrong format", { ...copy(), format: "ductura-error-catalog-v2" }, "format"],
    ["errors not an array", { ...copy(), errors: {} }, "errors: not an array"],
    ["extra entry field", entry({ body: {} }), "errors#0: wrong fields"],
    ["status as a string", entry({ status: "400" }), "errors#0: bad status"],
    ["fractional status", entry({ status: 400.5 }), "errors#0: bad status"],
    ["status out of range", entry({ status: 600 }), "errors#0: bad status"],
    ["empty code", entry({ code: "" }), "errors#0: bad code"],
    ...["\r\n", "\t", "\u00a0", "\u007f"].map(
      (bad) =>
        [
          `code with ${JSON.stringify(bad)}`,
          entry({ code: `bad${bad}` }),
          "errors#0: bad code",
        ] as [string, unknown, string],
    ),
    ["key with NBSP", entry({ messageKey: "errors.bad\u00a0x" }), "errors#0: bad key"],
    ["key without area", entry({ messageKey: "badRequest" }), "errors#0: bad key"],
    [
      "duplicate code",
      { ...copy(), errors: [...copy().errors, copy().errors[0]] },
      "errors: duplicate bad_request",
    ],
  ];
  it.each(cases)("rejects %s", (_name, raw, error) => {
    expect(readCatalog(raw)).toBe(error);
  });

  it.each(["__proto__", "toString", "constructor"])("rejects an own %s field from JSON", (key) => {
    const raw = JSON.parse(
      `{"status":400,"code":"bad_request","messageKey":"errors.badRequest","${key}":1}`,
    );
    expect(readCatalog({ ...copy(), errors: [raw] })).toBe("errors#0: wrong fields");
    expect(
      readCatalog(JSON.parse(`{"format":"${FORMAT}","errors":[],"shared":[],"${key}":1}`)),
    ).toBe("root");
  });

  it("rejects a shared entry that the catalogue does not have with the same status and key", () => {
    const raw = copy();
    raw.shared[0] = { ...raw.shared[0]!, messageKey: "errors.other" };
    expect(readCatalog(raw)).toMatch(/^shared: .* not in errors$/u);
  });

  it("allows two entries with one status (401 unauthenticated and session_expired)", () => {
    expect(RAW.errors.filter((e) => e.status === 401)).toHaveLength(2);
  });
});

describe("errors/catalog.json equals the server (DAN-928)", () => {
  it("is read strictly and has the server's codes, statuses and keys, in order", () => {
    expect(readCatalog(JSON.parse(FILE))).toEqual(SERVER);
  });

  it.each([
    ["a changed status", (raw: typeof RAW) => (raw.errors[3]!.status = 410)],
    ["a changed code", (raw: typeof RAW) => (raw.errors[3]!.code = "gone")],
    ["a changed key", (raw: typeof RAW) => (raw.errors[3]!.messageKey = "errors.gone")],
    ["a missing entry", (raw: typeof RAW) => raw.errors.pop()],
    [
      "an extra entry",
      (raw: typeof RAW) =>
        raw.errors.push({ status: 410, code: "gone", messageKey: "errors.gone" }),
    ],
    ["a missing shared entry", (raw: typeof RAW) => raw.shared.pop()],
  ])("a file with %s no longer equals the server", (_name, mutate) => {
    const raw = copy();
    mutate(raw);
    expect(readCatalog(raw)).not.toEqual(SERVER);
  });
});

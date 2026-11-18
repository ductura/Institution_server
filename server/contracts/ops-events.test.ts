// DAN-843-1 (S-1K.5-b, UGOVOR Ductus#2028): the operator's read of events as
// a contract and vectors only; the handler is 843-2. Closed tables over the
// query and the 200 body, the refusals first: each case changes one place of
// an input that passes unchanged.
import { readFileSync } from "node:fs";

import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { ROUTES } from "./index.ts";

const ID = "ops.events.get";
const route = ROUTES.find((r) => r.id === ID);
// No route, no pass: a missing schema throws instead of refusing everything.
function schemaOf(part: "query" | "body") {
  const schema = part === "query" ? route?.request.query : route?.responses[0]?.body;
  if (schema === undefined) throw new Error(`${ID} has no ${part} schema`);
  return schema;
}

const QUERY = { from: "2026-11-18T00:00:00Z", to: "2026-11-18T12:00:00.000Z", after: "41" };
const EVENT = {
  seq: 42,
  at: "2026-11-18T09:15:00.123Z",
  kind: "authn.login_failed",
  requestId: "0b1c2d3e-4f50-4a61-8b72-93a4b5c6d7e8",
  accountKind: "app_admin",
  fields: { reason: "provider_unavailable", network: "192.0.2.0/24", attempt: 2, again: false },
};
const PAGE = { events: [EVENT], next: null };

const queryOk = (query: unknown) => Value.Check(schemaOf("query"), query);
const bodyOk = (body: unknown) => Value.Check(schemaOf("body"), body);
const withQuery = (key: string, value: unknown) => queryOk({ ...QUERY, [key]: value });
const withEvent = (key: string, value: unknown) =>
  bodyOk({ ...PAGE, events: [{ ...EVENT, [key]: value }] });
const withFields = (fields: unknown) => withEvent("fields", fields);
const without = (object: Record<string, unknown>, key: string) =>
  Object.fromEntries(Object.entries(object).filter(([k]) => k !== key));
const events = (count: number) =>
  Array.from({ length: count }, (_, i) => ({ ...EVENT, seq: i + 1 }));

// A character around a value: line ends, tab, space, NBSP, DEL, NUL.
const AROUND = ["\n", "\r\n", "\r", "\t", " ", " ", "\u007f", "\u0000"];
const MAX_SAFE = Number.MAX_SAFE_INTEGER;

describe("ops.events.get refuses the query", () => {
  it("passes unchanged", () => expect(queryOk(QUERY)).toBe(true));

  it.each([
    "",
    "2026-11-18T00:00:00z",
    "2026-11-18t00:00:00Z",
    "2026-11-18 00:00:00Z",
    "2026-11-18T00:00:00+01:00",
    "2026-11-18T00:00:00",
    "2026-11-18T00:00Z",
    "2026-11-18T00:00:00.0000Z",
    "2026-11-18T00:00:00.Z",
    "20261118T000000Z",
    "2026-02-30T00:00:00Z",
    "2026-02-29T00:00:00Z",
    "1900-02-29T00:00:00Z",
    "2100-02-29T00:00:00Z",
    "0000-02-29T00:00:00Z",
    "2026-04-31T00:00:00Z",
    "2026-06-31T00:00:00Z",
    "2026-09-31T00:00:00Z",
    "2026-11-31T00:00:00Z",
    "2026-11-32T00:00:00Z",
    "2026-11-00T00:00:00Z",
    "2026-13-01T00:00:00Z",
    "2026-00-10T00:00:00Z",
    "0000-01-01T00:00:00Z",
    "2026-11-18T24:00:00Z",
    "2026-11-18T23:60:00Z",
    "2026-11-18T23:59:60Z",
    "2026-11-18T00:00:0٠Z",
    "2026-11-18T00:00:0０Z",
    ...AROUND.map((c) => `2026-11-18T00:00:00Z${c}`),
    ...AROUND.map((c) => `${c}2026-11-18T00:00:00Z`),
  ])("from or to %j", (time) => {
    expect(withQuery("from", time)).toBe(false);
    expect(withQuery("to", time)).toBe(false);
  });

  it.each([
    "",
    "-1",
    "01",
    "00",
    "1e3",
    "0x1",
    "1.0",
    "+1",
    "12345678901234567",
    "١",
    ...AROUND.map((c) => `41${c}`),
    ...AROUND.map((c) => `${c}41`),
  ])("after %j", (after) => expect(withQuery("after", after)).toBe(false));

  it.each([41, null, true])("after as a non-string %j", (after) =>
    expect(withQuery("after", after)).toBe(false),
  );

  it.each(["from", "to"])("without %s", (key) => expect(queryOk(without(QUERY, key))).toBe(false));

  it.each(["kind", "limit", "toString", "constructor", "From", "after "])(
    "an unknown parameter %j",
    (key) => expect(withQuery(key, "1")).toBe(false),
  );

  it("an own __proto__ parameter", () => {
    const query = JSON.parse(`{"from":"${QUERY.from}","to":"${QUERY.to}","__proto__":"1"}`);
    expect(Object.keys(query)).toContain("__proto__");
    expect(queryOk(query)).toBe(false);
  });
});

describe("ops.events.get refuses the 200 body", () => {
  it("passes unchanged", () => expect(bodyOk(PAGE)).toBe(true));

  it.each(["seq", "at", "kind", "requestId", "accountKind", "fields"])("an event without %s", (k) =>
    expect(bodyOk({ ...PAGE, events: [without(EVENT, k)] })).toBe(false),
  );

  it.each(["payload", "ip", "token", "toString"])("an event with the key %j", (key) =>
    expect(withEvent(key, "x")).toBe(false),
  );

  it.each([0, -1, 1.5, MAX_SAFE + 1, "42", null])("seq %j", (seq) =>
    expect(withEvent("seq", seq)).toBe(false),
  );

  it.each([
    "2026-11-18T09:15:00Z",
    "2026-11-18T09:15:00.12Z",
    "2026-11-18T09:15:00.123+00:00",
    "2026-11-18T09:15:00.123z",
    // Days and times off the calendar (QA on #320 at fc6432b).
    "2026-02-30T09:15:00.123Z",
    "2026-02-29T09:15:00.123Z",
    "1900-02-29T09:15:00.123Z",
    "2100-02-29T09:15:00.123Z",
    "0000-02-29T09:15:00.123Z",
    "0000-01-01T09:15:00.123Z",
    "2026-04-31T09:15:00.123Z",
    "2026-11-31T09:15:00.123Z",
    "2026-11-32T09:15:00.123Z",
    "2026-11-00T09:15:00.123Z",
    "2026-13-01T09:15:00.123Z",
    "2026-00-01T09:15:00.123Z",
    "2026-11-18T24:00:00.000Z",
    "2026-11-18T23:60:00.000Z",
    "2026-11-18T23:59:60.000Z",
    ...AROUND.map((c) => `2026-11-18T09:15:00.123Z${c}`),
    null,
  ])("at %j", (at) => expect(withEvent("at", at)).toBe(false));

  it.each([
    "",
    "authn",
    "Authn.login_failed",
    "authn.login-failed",
    "authn.login.failed",
    "1authn.login_failed",
    "authn._x",
    `a.${"b".repeat(63)}`,
    ...AROUND.map((c) => `authn.login_failed${c}`),
    ...AROUND.map((c) => `authn.${c}login_failed`),
    null,
  ])("kind %j", (kind) => expect(withEvent("kind", kind)).toBe(false));

  it.each([
    "",
    EVENT.requestId.toUpperCase(),
    EVENT.requestId.slice(1),
    `${EVENT.requestId}\n`,
    `{${EVENT.requestId}}`,
    `${EVENT.requestId}\r\n`,
  ])("requestId %j", (requestId) => expect(withEvent("requestId", requestId)).toBe(false));

  it.each(["", "a".repeat(33), "Student", "app-admin", "student\n", "stu\u00a0dent"])(
    "accountKind %j",
    (accountKind) => expect(withEvent("accountKind", accountKind)).toBe(false),
  );

  it.each([
    { "a-b": "x" },
    Object.fromEntries([["a_b", "x"]]),
    Object.fromEntries([["_a", "x"]]),
    { "a.b": "x" },
    { "1a": "x" },
    { "": "x" },
    { "a\n": "x" },
    { "a ": "x" },
    { a: { b: 1 } },
    { a: [1] },
  ])("fields %j", (fields) => expect(withFields(fields)).toBe(false));

  it.each([null, [], "x"])("fields as %j", (fields) => expect(withFields(fields)).toBe(false));

  it("an own __proto__ field", () => {
    const fields = JSON.parse('{"__proto__":"x"}');
    expect(Object.keys(fields)).toEqual(["__proto__"]);
    expect(withFields(fields)).toBe(false);
  });

  it("1001 events", () => expect(bodyOk({ events: events(1001), next: 1001 })).toBe(false));

  it.each([0, -1, 1.5, MAX_SAFE + 1, "1000"])("next %j", (next) =>
    expect(bodyOk({ ...PAGE, next })).toBe(false),
  );

  it("without next, or a key beside events and next", () => {
    expect(bodyOk({ events: [EVENT] })).toBe(false);
    expect(bodyOk({ ...PAGE, total: 1 })).toBe(false);
  });
});

describe("ops.events.get accepts", () => {
  it.each([
    "2026-11-18T00:00:00Z",
    "2026-11-18T00:00:00.1Z",
    "2026-11-18T00:00:00.12Z",
    "2026-11-18T00:00:00.123Z",
    "2028-02-29T23:59:59Z",
    "1600-02-29T00:00:00Z",
    "0004-02-29T00:00:00Z",
    "9999-12-31T23:59:59.999Z",
    "2026-01-31T00:00:00Z",
    "2026-10-31T00:00:00Z",
    "2000-02-29T00:00:00Z",
    "0001-01-01T00:00:00Z",
  ])("from and to %j", (time) => {
    expect(withQuery("from", time)).toBe(true);
    expect(withQuery("to", time)).toBe(true);
  });

  it.each(["0", "1", "9007199254740991", "9".repeat(16)])("after %j", (after) =>
    expect(withQuery("after", after)).toBe(true),
  );

  it("no after", () => expect(queryOk(without(QUERY, "after"))).toBe(true));

  // Every day of 1999 to 2032 (both leap year rules), as the query and as at.
  it("every day Date.toISOString gives from 1999 to 2032", () => {
    for (let ms = Date.UTC(1999, 0, 1); ms < Date.UTC(2033, 0, 1); ms += 86_400_000 + 1_001) {
      const at = new Date(ms).toISOString();
      expect(withQuery("from", at), at).toBe(true);
      expect(withEvent("at", at), at).toBe(true);
    }
  });

  it("accountKind of 32 characters, field names with a capital, kinds with digits", () => {
    expect(withEvent("accountKind", "a".repeat(32))).toBe(true);
    expect(withEvent("accountKind", "network_engineer")).toBe(true);
    expect(
      withFields(
        Object.fromEntries([
          ["Network", "x"],
          ["durationMs", 3],
          ["a1B2", true],
        ]),
      ),
    ).toBe(true);
    expect(withEvent("kind", "s3.put2_done")).toBe(true);
  });

  it("an empty page, a full page with next, and null where null is allowed", () => {
    expect(bodyOk({ events: [], next: null })).toBe(true);
    expect(bodyOk({ events: events(1000), next: 1000 })).toBe(true);
    expect(withEvent("requestId", null)).toBe(true);
    // operator_log keeps any lowercase UUID, not only version 4.
    expect(withEvent("requestId", "6ba7b810-9dad-11d1-80b4-00c04fd430c8")).toBe(true);
    expect(withEvent("accountKind", null)).toBe(true);
    expect(withEvent("seq", MAX_SAFE)).toBe(true);
    expect(withEvent("kind", `a.${"b".repeat(62)}`)).toBe(true);
  });

  it("the field names and values operator_log gives", () => {
    expect(withFields({})).toBe(true);
    expect(withFields({ toString: "hidden", a1: null, b: 1.5, c: true, d: "none" })).toBe(true);
  });
});

// $ and \d mean other things outside JavaScript ($ before a final LF, \d any
// Unicode digit), so a client validator in another language would accept
// more: every pattern of the route ends at the end of the input, ASCII only.
describe("ops.events.get patterns", () => {
  const END = "(?![\\s\\S])";
  const patterns = (node: unknown): string[] =>
    node === null || typeof node !== "object"
      ? []
      : Object.entries(node).flatMap(([key, value]) =>
          key === "pattern" && typeof value === "string"
            ? [value]
            : [
                ...(key === "patternProperties" ? Object.keys(value as object) : []),
                ...patterns(value),
              ],
        );
  const all = [...patterns(schemaOf("query")), ...patterns(schemaOf("body"))];

  it.each(all)("%s", (pattern) => {
    expect(pattern.startsWith("^")).toBe(true);
    expect(pattern.endsWith(END)).toBe(true);
    // Without the end, no shorthand class anywhere, inside [] or out.
    expect(pattern.slice(0, -END.length)).not.toMatch(/\\[dDwWsS]/u);
  });

  it("are all found", () => expect(all.length).toBe(8));
});

// The 422 vector proves the 24-hour bound only if its query passes the schema
// and is one millisecond over it.
describe("the vector window-over-24-hours", () => {
  it("is a query of the schema, 24 hours and 1 ms long", () => {
    const file = JSON.parse(
      readFileSync(new URL("./vectors/ops.events.get.json", import.meta.url), "utf8"),
    ) as { vectors: { name: string; request: { query: { from: string; to: string } } }[] };
    const query = file.vectors.find((v) => v.name === "window-over-24-hours")?.request.query;
    expect(query).toBeDefined();
    expect(queryOk(query)).toBe(true);
    expect(Date.parse(query!.to) - Date.parse(query!.from)).toBe(24 * 3_600_000 + 1);
  });
});

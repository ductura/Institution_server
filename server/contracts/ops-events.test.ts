// DAN-843-1b (S-1K.5-b, OPSEG Ductus#2028 c.6981773723): the operator's read
// of events as a contract and vectors only; the handler is 843-2. Closed tables over the
// query and the 200 body, the refusals first: each case changes one place of
// an input that passes unchanged.
import { readFileSync } from "node:fs";

import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { ROUTES } from "./index.ts";
import { REQUEST_ID_PATTERN } from "./schema/index.ts";

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
const AROUND = ["\n", "\r\n", "\r", "\t", " ", "\u00a0", "\u007f", "\u0000"];
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
    ...AROUND.map((c) => `2026-11-18${c}T00:00:00Z`),
    ...AROUND.map((c) => `2026-11-18T00:00:00${c}Z`),
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
    // One over 2^53-1, and the largest 16 digits: seq is at most 2^53-1.
    "9007199254740992",
    "9007199254741000",
    "9007199254750991",
    "9100000000000000",
    "9999999999999999",
    "١",
    ...AROUND.map((c) => `41${c}`),
    ...AROUND.map((c) => `${c}41`),
    ...AROUND.map((c) => `4${c}1`),
  ])("after %j", (after) => expect(withQuery("after", after)).toBe(false));

  it.each([41, null, true])("after as a non-string %j", (after) =>
    expect(withQuery("after", after)).toBe(false),
  );

  it.each(["from", "to"])("without %s", (key) => expect(queryOk(without(QUERY, key))).toBe(false));

  it.each([
    ...["kind", "limit", "toString", "constructor", "hasOwnProperty", "From", "after "],
    ...AROUND.flatMap((c) => [`from${c}`, `${c}from`, `af${c}ter`]),
  ])("an unknown parameter %j", (key) => expect(withQuery(key, "1")).toBe(false));

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
    "2026-06-31T09:15:00.123Z",
    "2026-09-31T09:15:00.123Z",
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

  it("an own __proto__ in an event or in the body", () => {
    const event = JSON.parse(`{"__proto__":"x",${JSON.stringify(EVENT).slice(1)}`);
    expect(Object.keys(event)).toContain("__proto__");
    expect(bodyOk({ ...PAGE, events: [event] })).toBe(false);
    const body = JSON.parse('{"events":[],"next":null,"__proto__":{"next":null}}');
    expect(Object.keys(body)).toContain("__proto__");
    expect(bodyOk(body)).toBe(false);
  });

  it("1001 events", () => expect(bodyOk({ events: events(1001), next: 1001 })).toBe(false));

  it.each([0, -1, 1.5, MAX_SAFE + 1, 2 ** 53, "1000", `${MAX_SAFE}`])("next %j", (next) =>
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
    "2024-02-29T00:00:00Z",
    "0001-01-01T00:00:00Z",
  ])("from and to %j", (time) => {
    expect(withQuery("from", time)).toBe(true);
    expect(withQuery("to", time)).toBe(true);
  });

  it.each([
    ...["0", "1", "9", "10", "999999999999999", "1000000000000000", "8999999999999999"],
    ...["9006999999999999", "9007099999999999", "9007199254739999", "9007199254740989"],
    ...["9007199254740990", "9007199254740991"],
  ])("after %j", (after) => expect(withQuery("after", after)).toBe(true));

  it("no after", () => expect(queryOk(without(QUERY, "after"))).toBe(true));

  // The schema against an oracle on the edges of 2^53-1: each digit moved by
  // one, every length to 17 digits, leading zeros and signs.
  it("after exactly when it is a decimal of 0 to 2^53-1 without a leading zero", () => {
    const max = String(MAX_SAFE);
    const oracle = (s: string) => /^(?:0|[1-9][0-9]*)$/u.test(s) && BigInt(s) <= BigInt(MAX_SAFE);
    const inputs = new Set(["", "0", "00", "01", "+1", "-0", "-1", max, `0${max}`, `${max}0`]);
    for (const [i, digit] of [...max].entries())
      for (const step of [-1, 1]) {
        const d = Number(digit) + step;
        if (d < 0 || d > 9) continue;
        inputs.add(`${max.slice(0, i)}${d}${max.slice(i + 1)}`);
        inputs.add(`${max.slice(0, i)}${d}${"9".repeat(max.length - 1 - i)}`);
        inputs.add(`${max.slice(0, i)}${d}${"0".repeat(max.length - 1 - i)}`);
      }
    for (let n = 1; n <= 17; n += 1) {
      inputs.add("9".repeat(n));
      inputs.add(`1${"0".repeat(n - 1)}`);
      inputs.add(max.slice(0, n));
    }
    for (const delta of [-2n, -1n, 1n, 2n, 1000n]) inputs.add(String(BigInt(max) + delta));
    let accepted = 0;
    for (const after of inputs) {
      expect(withQuery("after", after), after).toBe(oracle(after));
      if (oracle(after)) accepted += 1;
    }
    expect(accepted).toBeGreaterThan(40);
    expect(inputs.size - accepted).toBeGreaterThan(20);
  });

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

  // QA on #320 at b777a70: a full page ending at the largest seq. A bound of
  // 1000 on next alone (a mutant) refuses it.
  it("a full page whose last seq, and so next, is 2^53-1", () => {
    const last = Array.from({ length: 1000 }, (_, i) => ({ ...EVENT, seq: MAX_SAFE - 999 + i }));
    expect(last.at(-1)?.seq).toBe(MAX_SAFE);
    expect(bodyOk({ events: last, next: MAX_SAFE })).toBe(true);
    expect(bodyOk({ events: last, next: MAX_SAFE - 1 })).toBe(true);
    expect(bodyOk({ events: [], next: MAX_SAFE })).toBe(true);
  });

  it("the field names and values operator_log gives", () => {
    expect(withFields({})).toBe(true);
    expect(withFields({ toString: "hidden", a1: null, b: 1.5, c: true, d: "none" })).toBe(true);
    // operator_log keeps a mask shorter than /24 or /48 (pgTAP 040, case 3).
    expect(withFields({ ip: "10.0.0.0/8", network: "2001:db8::/32" })).toBe(true);
  });
});

// $ and \d mean other things outside JavaScript ($ before a final LF, \d any
// Unicode digit), so a client validator in another language would accept
// more: every pattern of the route ends at the end of the input, ASCII only.
// The query, the 200 body and every error body are walked. The one exception
// is REQUEST_ID_PATTERN of the shared problem body (schema/index.ts), which
// ends with $ for every route: a known limit, DAN-1098 (QA on #320 at
// 221669b, point 2). It is exempt by its exact text, so nothing else is.
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
  const own = [...patterns(schemaOf("query")), ...patterns(schemaOf("body"))];
  const ofErrors = (route?.errors ?? []).flatMap((e) => patterns(e.body));

  /** A | outside any group or class, and a . outside a class, each unescaped. */
  const topLevel = (pattern: string) => {
    let depth = 0;
    let inClass = false;
    const found = { alternation: false, dot: false };
    for (let i = 0; i < pattern.length; i += 1) {
      const c = pattern[i];
      if (c === "\\") i += 1;
      else if (inClass) inClass = c !== "]";
      else if (c === "[") inClass = true;
      else if (c === "(") depth += 1;
      else if (c === ")") depth -= 1;
      else if (c === "|" && depth === 0) found.alternation = true;
      else if (c === ".") found.dot = true;
    }
    return found;
  };

  it.each(own)("%s", (pattern) => {
    expect(pattern.startsWith("^")).toBe(true);
    expect(pattern.endsWith(END)).toBe(true);
    const body = pattern.slice(0, -END.length);
    // Before the end, no shorthand class or word boundary, inside [] or out.
    expect(body).not.toMatch(/\\[dDwWsSbB]/u);
    expect(topLevel(body)).toEqual({ alternation: false, dot: false });
  });

  it("the scan sees an alternation at the top and a bare dot", () => {
    expect(topLevel("^a|b")).toEqual({ alternation: true, dot: false });
    expect(topLevel("^(?:a|b)[.|]\\.")).toEqual({ alternation: false, dot: false });
    expect(topLevel("^a.b")).toEqual({ alternation: false, dot: true });
  });

  it("are all found", () => expect(own.length).toBe(8));

  it("of the error bodies are only the exempt request id, DAN-1098", () => {
    expect(route?.errors.map((e) => e.status)).toEqual([401, 403, 422, 503]);
    expect(ofErrors).toEqual(Array<string>(4).fill(REQUEST_ID_PATTERN));
    expect(REQUEST_ID_PATTERN).toBe(
      "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    );
  });
});

// TypeBox closes an object only with additionalProperties: false, and a
// Record only when asked (fields). Every object of the query and the 200
// body is closed, so a key beside the contract, own __proto__ included, is
// refused by any validator that reads the document.
describe("ops.events.get objects are closed", () => {
  const objects = (node: unknown, path: string): [string, Record<string, unknown>][] => {
    if (node === null || typeof node !== "object") return [];
    const here: [string, Record<string, unknown>][] =
      (node as { type?: unknown }).type === "object"
        ? [[path, node as Record<string, unknown>]]
        : [];
    return [
      ...here,
      ...Object.entries(node).flatMap(([key, value]) => objects(value, `${path}/${key}`)),
    ];
  };
  const all = [...objects(schemaOf("query"), "query"), ...objects(schemaOf("body"), "body")];

  it("finds the query, the body, the event and fields", () => expect(all).toHaveLength(4));

  it.each(all.map(([path, node]) => [path, node] as const))(
    "%s has additionalProperties false",
    (_path, node) => expect(node.additionalProperties).toBe(false),
  );
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

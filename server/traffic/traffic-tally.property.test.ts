// DAN-834-3, criterion "a sample carries no personal data": whatever else a
// traffic.request record holds (IP, request id, route, invented names and
// e-mail addresses, control characters), the samples depend only on status
// and duration and contain none of it. Invented values only (.invalid).
import { fc, test } from "@fast-check/vitest";
import { expect } from "vitest";

import { createTrafficTally } from "./traffic-tally.ts";

const READ_KEYS = new Set(["event", "status", "durationMs"]);
const ODD = ["\r\n", "\t", "\u00a0", "\u007f", "@", ".", "-"];

/** Text with at least one character the samples' JSON never holds (traffic-tally.test.ts). */
const personal = fc
  .tuple(fc.string(), fc.constantFrom(...ODD), fc.string())
  .map(([a, odd, b]) => a + odd + b);
const named = fc.constantFrom(
  "Iva Horvat",
  "iva.horvat@student.invalid",
  "Ana-Marija",
  "Pero Perić, Zagreb",
);
const ip = fc.oneof(fc.ipV4(), fc.ipV6());
const text = fc.oneof(personal, named, ip);
const extraKey = fc
  .oneof(fc.string(), fc.constantFrom("toString", "__proto__", "constructor", "email", "name"))
  .filter((key) => !READ_KEYS.has(key));

/** Own keys from pairs; __proto__ becomes an own key, never the prototype. */
function own(pairs: readonly (readonly [string, unknown])[]): Record<string, unknown> {
  const target: Record<string, unknown> = {};
  for (const [key, value] of pairs) {
    Object.defineProperty(target, key, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return target;
}

const recordOf = (
  status: number,
  durationMs: number,
  other: readonly string[],
  extra: readonly (readonly [string, string])[],
) => ({
  time: "2026-11-16T09:30:00.000Z",
  event: "traffic.request",
  requestId: other[0],
  accountKind: "anonymous",
  fields: own([
    ["method", other[1]],
    ["route", other[2]],
    ["ip", other[3]],
    ...extra,
    ["status", status],
    ["durationMs", durationMs],
  ]),
});

const timing = fc.tuple(
  fc.integer({ min: 100, max: 599 }),
  fc.integer({ min: 0, max: 86_400_000 }),
);
const others = fc.tuple(
  fc.array(text, { minLength: 4, maxLength: 4 }),
  fc.array(fc.tuple(extraKey, text), { maxLength: 4 }),
);
const run = (records: readonly unknown[]) => {
  const tally = createTrafficTally();
  for (const record of records) tally.observe(record);
  return tally.take();
};

test.prop([fc.array(fc.tuple(timing, others, others), { minLength: 1, maxLength: 30 })])(
  "samples depend only on status and duration and carry no other text",
  (rows) => {
    const left = rows.map(([[s, d], [o, e]]) => recordOf(s, d, o, e));
    const right = rows.map(([[s, d], , [o, e]]) => recordOf(s, d, o, e));
    const samples = run(left);
    expect(run(right)).toEqual(samples);
    const json = JSON.stringify(samples);
    for (const [, [other, extra]] of rows) {
      for (const value of [...other, ...extra.flat()]) {
        if (/[^[\]{}":,a-z0-9_]/.test(value)) expect(json.includes(value), value).toBe(false);
      }
    }
  },
);

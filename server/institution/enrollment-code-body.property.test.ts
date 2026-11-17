// DAN-852-3a (contract Ductus#1836 c.6945059378): any real instant of the
// years 1 to 9999, written as toISOString or with Z replaced by a valid
// offset, is accepted; the same with one field made known invalid is refused.
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { parseEnrollmentCodeBody } from "./schemas.ts";

const instant = fc
  .date({
    min: new Date("0001-01-01T00:00:00.000Z"),
    max: new Date("9999-12-31T23:59:59.999Z"),
    noInvalidDate: true,
  })
  .map((date) => date.toISOString());
const two = (n: number) => String(n).padStart(2, "0");
const offset = fc
  .tuple(
    fc.constantFrom("+", "-"),
    fc.integer({ min: 0, max: 15 }),
    fc.integer({ min: 0, max: 59 }),
  )
  .map(([sign, h, m]) => `${sign}${two(h)}:${two(m)}`);
const written = fc.oneof(
  instant,
  fc.tuple(instant, offset).map(([iso, zone]) => iso.replace("Z", zone)),
);
// Each breaks exactly one field of YYYY-MM-DDTHH:MM:SS.sssZ.
const breaks: ((iso: string) => string)[] = [
  (iso) => `${iso.slice(0, 5)}13${iso.slice(7)}`,
  (iso) => `${iso.slice(0, 8)}32${iso.slice(10)}`,
  (iso) => `${iso.slice(0, 11)}24${iso.slice(13)}`,
  (iso) => `${iso.slice(0, 14)}60${iso.slice(16)}`,
  (iso) => `${iso.slice(0, 17)}60${iso.slice(19)}`,
  (iso) => `${iso}\n`,
  (iso) => `${iso} `,
  (iso) => ` ${iso}`,
];

describe("parseEnrollmentCodeBody properties", () => {
  it("accepts every real written instant unchanged", () => {
    fc.assert(
      fc.property(written, (validUntil) => {
        expect(parseEnrollmentCodeBody({ validUntil })).toEqual({ validUntil });
      }),
    );
  });

  it("refuses the same instant with one field broken", () => {
    fc.assert(
      fc.property(instant, fc.integer({ min: 0, max: breaks.length - 1 }), (iso, which) => {
        expect(parseEnrollmentCodeBody({ validUntil: breaks[which]!(iso) })).toBeNull();
      }),
    );
  });
});

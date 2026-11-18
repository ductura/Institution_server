// DAN-853-1c: every string of at most 64 UTF-16 units is accepted unchanged,
// every longer one is refused, and any other key next to the code is refused.
// Strings are built unit by unit (any of the 65 536, lone surrogates
// included) with the length chosen first, often right at the boundary, since
// fast-check counts string lengths in code points.
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { parseEnrollmentBody } from "./schemas.ts";

const ofUnits = (length: fc.Arbitrary<number>) =>
  length.chain((n) =>
    fc
      .array(fc.integer({ min: 0, max: 0xffff }), { minLength: n, maxLength: n })
      .map((units) => String.fromCharCode(...units)),
  );
const accepted = ofUnits(fc.oneof(fc.constantFrom(0, 1, 63, 64), fc.integer({ min: 0, max: 64 })));
const refused = ofUnits(fc.oneof(fc.constantFrom(65, 66), fc.integer({ min: 65, max: 200 })));

describe("parseEnrollmentBody properties", () => {
  it("the generators reach the boundary in UTF-16 units", () => {
    const sample = (arbitrary: fc.Arbitrary<string>) =>
      fc.sample(arbitrary, { numRuns: 400, seed: 853 }).map((s) => s.length);
    expect(sample(accepted)).toContain(64);
    expect(sample(refused)).toContain(65);
    const units = fc.sample(accepted, { numRuns: 400, seed: 853 });
    expect(units.some((s) => /[\ud800-\udfff]/.test(s))).toBe(true);
  });

  it("accepts every code of 0 to 64 units unchanged", () => {
    fc.assert(
      fc.property(accepted, (code) => {
        expect(parseEnrollmentBody({ code })).toEqual({ code });
      }),
    );
  });

  it("refuses every code of 65 to 200 units", () => {
    fc.assert(
      fc.property(refused, (code) => {
        expect(parseEnrollmentBody({ code })).toBeNull();
      }),
    );
  });

  it("refuses any other key next to a valid code", () => {
    fc.assert(
      fc.property(
        fc.string().filter((key) => key !== "code"),
        fc.jsonValue(),
        (key, extra) => {
          const body: Record<string, unknown> = { code: "IZMISLJENI-KOD-0001" };
          Object.defineProperty(body, key, {
            value: extra,
            enumerable: true,
            configurable: true,
            writable: true,
          });
          expect(parseEnrollmentBody(body)).toBeNull();
        },
      ),
    );
  });
});

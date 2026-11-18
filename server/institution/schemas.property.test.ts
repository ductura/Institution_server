// DAN-852-1: a body built from parts of known validity is accepted exactly
// when every part is valid and nothing is extra. Every value is invented.
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { parseCourseBody, parseEnrollmentBody } from "./schemas.ts";

const part = <T>(good: fc.Arbitrary<T>, bad: fc.Arbitrary<unknown>) =>
  fc.oneof(
    good.map((value) => ({ ok: true, value })),
    bad.map((value) => ({ ok: false, value })),
  );

const goodName = fc
  .string({ minLength: 1, maxLength: 158, unit: "grapheme" })
  .filter((s) => s.length <= 158)
  .map((s) => `K${s}K`);
const badName = fc.oneof(
  fc.constant(""),
  fc.string().map((s) => ` ${s}`),
  fc.string().map((s) => `${s}\t`),
  fc.constant("x".repeat(161)),
  fc.integer(),
);
const goodYear = fc.integer({ min: 0, max: 9998 }).map((y) => {
  const pad = (n: number) => String(n).padStart(4, "0");
  return `${pad(y)}/${pad(y + 1)}`;
});
const badYear = fc.oneof(
  fc
    .integer({ min: 0, max: 9997 })
    .map((y) => `${String(y).padStart(4, "0")}/${String(y + 2).padStart(4, "0")}`),
  fc.string(),
  fc.constant(null),
);
const goodPolicy = fc.constantFrom("prohibited", "partially_allowed", "encouraged");
const badPolicy = fc.oneof(
  fc.string().filter((s) => !["prohibited", "partially_allowed", "encouraged"].includes(s)),
  fc.boolean(),
);

describe("parseCourseBody (property)", () => {
  it("accepts exactly when all three parts are valid and no key is extra", () => {
    fc.assert(
      fc.property(
        part(goodName, badName),
        part(goodYear, badYear),
        part(goodPolicy, badPolicy),
        fc.option(fc.constantFrom("institutionId", "userId", "role", "__proto__"), {
          nil: undefined,
        }),
        (name, year, policy, extra) => {
          const body: Record<string, unknown> = {
            name: name.value,
            academicYear: year.value,
            aiPolicy: policy.value,
          };
          if (extra !== undefined)
            Object.defineProperty(body, extra, { value: 1, enumerable: true });
          const valid = name.ok && year.ok && policy.ok && extra === undefined;
          const parsed = parseCourseBody(body);
          const expected = valid
            ? { name: name.value, academicYear: year.value, aiPolicy: policy.value }
            : null;
          expect(parsed).toEqual(expected);
        },
      ),
    );
  });
});

// DAN-853-1c: every string of at most 64 UTF-16 units is accepted unchanged,
// every longer one is refused, and any other key next to the code is refused.
// Strings are built unit by unit (any of the 65 536, lone surrogates
// included) with the length chosen first, often right at the boundary, since
// fast-check counts string lengths in code points.
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

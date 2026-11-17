// DAN-852-1: a body built from parts of known validity is accepted exactly
// when every part is valid and nothing is extra. Every value is invented.
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { parseCourseBody } from "./schemas.ts";

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

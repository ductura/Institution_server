// DAN-853-1c: every string of at most 64 UTF-16 units is accepted unchanged,
// every longer one is refused, and any other key next to the code is refused.
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { parseEnrollmentBody } from "./schemas.ts";

const text = (minLength: number, maxLength: number) =>
  fc
    .string({ unit: "binary", minLength, maxLength })
    .filter((s) => s.length >= minLength && s.length <= maxLength);

describe("parseEnrollmentBody properties", () => {
  it("accepts every code of 0 to 64 units unchanged", () => {
    fc.assert(
      fc.property(text(0, 64), (code) => {
        expect(parseEnrollmentBody({ code })).toEqual({ code });
      }),
    );
  });

  it("refuses every code of 65 to 200 units", () => {
    fc.assert(
      fc.property(text(65, 200), (code) => {
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
          const body = JSON.parse(JSON.stringify({ code: "IZMISLJENI-KOD-0001" })) as Record<
            string,
            unknown
          >;
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

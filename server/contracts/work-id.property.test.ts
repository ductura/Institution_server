import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { isWorkId, WORK_ID_MAX, workIdFromPath } from "./index.ts";

// The evidence.document CHECK written out as plainly as possible, to compare with.
function byCheck(value: string): boolean {
  const points = [...value];
  return (
    points.length >= 1 &&
    points.length <= WORK_ID_MAX &&
    value === value.trim() &&
    points.every((p) => !/\p{Cc}/u.test(p) && !/\p{Cs}/u.test(p))
  );
}

// Plain text plus the characters the cases in docs/PLAN.md are about.
const piece = fc.oneof(
  fc.string({ unit: "grapheme", maxLength: 8 }),
  fc.constantFrom("'", ";", "%00", "../", "\u0000", " ", "\t", " ", "\uD800", "😀", "č"),
);
const candidate = fc.oneof(
  fc.array(piece, { maxLength: 6 }).map((parts) => parts.join("")),
  fc.string({ unit: "binary", maxLength: WORK_ID_MAX + 8 }),
  fc.integer({ min: 0, max: WORK_ID_MAX + 4 }).map((n) => "d".repeat(n)),
);

describe("isWorkId (property)", () => {
  it("agrees with the CHECK on every string", () => {
    fc.assert(
      fc.property(candidate, (value) => {
        expect(isWorkId(value)).toBe(byCheck(value));
      }),
    );
  });

  it("never throws and is false for anything but a string", () => {
    fc.assert(
      fc.property(fc.anything(), (value) => {
        expect(isWorkId(value)).toBe(typeof value === "string" && byCheck(value));
      }),
    );
  });

  it("round-trips every valid id through one encode and workIdFromPath", () => {
    fc.assert(
      fc.property(candidate.filter(isWorkId), (id) => {
        expect(workIdFromPath(encodeURIComponent(id))).toBe(id);
      }),
    );
  });

  it("workIdFromPath returns only ids isWorkId accepts", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary", maxLength: 64 }), (segment) => {
        const id = workIdFromPath(segment);
        expect(id === null || isWorkId(id)).toBe(true);
      }),
    );
  });
});

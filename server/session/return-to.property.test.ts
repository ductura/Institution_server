import fc from "fast-check";
import { expect, it } from "vitest";

import { safeReturnTo } from "./return-to.ts";

// Plan of attack #154, item 17: whatever path pieces an attacker combines,
// the result stays a path of this application.
const piece = fc.constantFrom(
  "/",
  "//",
  "\\",
  ".",
  "..",
  "%2e",
  "%2E",
  "%2e%2e",
  "%2f",
  "%5c",
  "?",
  "#",
  "@",
  ":",
  "zlo.test",
  "a",
  "api",
);
const candidate = fc.array(piece, { maxLength: 12 }).map((parts) => parts.join(""));

// Ported from @fast-check/vitest test.prop to fc.assert(fc.property(...)):
// same arbitrary and assertions, the default 100 runs either way.
it("never leaves the origin and never starts with // or /\\", () => {
  fc.assert(
    fc.property(
      fc.oneof(
        candidate,
        candidate.map((value) => `/${value}`),
        fc.string(),
      ),
      (value) => {
        const result = safeReturnTo(value);
        expect(result.startsWith("/")).toBe(true);
        expect(result.startsWith("//")).toBe(false);
        expect(result.startsWith("/\\")).toBe(false);
        expect(new URL(result, "https://ductus.example").origin).toBe("https://ductus.example");
      },
    ),
  );
});

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { canRead, canWrite } from "./access.ts";

const user = fc.string({ minLength: 1, maxLength: 12 });
const doc = fc.record(
  { ownerId: user, sharedWith: fc.array(user, { maxLength: 5 }) },
  { requiredKeys: ["ownerId"] },
);

describe("access rules", () => {
  it("whoever may write may also read", () => {
    fc.assert(
      fc.property(user, doc, (u, d) => {
        if (canWrite(u, d)) expect(canRead(u, d)).toBe(true);
      }),
    );
  });

  it("without a user there is no access", () => {
    fc.assert(
      fc.property(doc, (d) => {
        expect(canRead(null, d)).toBe(false);
        expect(canWrite(null, d)).toBe(false);
        expect(canRead("", d)).toBe(false);
      }),
    );
  });

  it("a collaborator may read but never write", () => {
    fc.assert(
      fc.property(doc, user, (d, u) => {
        fc.pre(u !== d.ownerId);
        const shared = { ...d, sharedWith: [...(d.sharedWith ?? []), u] };
        expect(canRead(u, shared)).toBe(true);
        expect(canWrite(u, shared)).toBe(false);
      }),
    );
  });
});

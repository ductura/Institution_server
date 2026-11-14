import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { canRead, canWrite } from "./access.ts";

const user = fc.string({ minLength: 1, maxLength: 12 });
const doc = fc.record(
  { ownerId: user, sharedWith: fc.array(user, { maxLength: 5 }) },
  { requiredKeys: ["ownerId"] },
);
// The user is drawn from the document itself as well, so owners, collaborators
// and strangers all actually come up; random strings alone almost never match.
const docAndUser = doc.chain((d) =>
  fc.tuple(fc.constant(d), fc.oneof(fc.constantFrom(d.ownerId, ...(d.sharedWith ?? [])), user)),
);

describe("access rules", () => {
  it("whoever may write may also read", () => {
    fc.assert(
      fc.property(docAndUser, ([d, u]) => {
        if (canWrite(u, d)) expect(canRead(u, d)).toBe(true);
        expect(canWrite(u, d)).toBe(u === d.ownerId);
        expect(canRead(u, d)).toBe(u === d.ownerId || (d.sharedWith ?? []).includes(u));
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

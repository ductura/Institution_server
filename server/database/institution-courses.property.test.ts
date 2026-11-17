// DAN-852-2a (contract Ductus#1836 c.6943486866): whatever the database
// throws never becomes a code and never escapes the port, and a returned
// string becomes a code exactly when it has the code's form.
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { createInstitutionCourses } from "./institution-courses.ts";
import type { ActorTransaction, WithActor } from "./with-actor.ts";

const CODE = /^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/;
const TOKEN = "izmisljeni-token-upisa-00000000000000000002";
const COURSE = "00000000-0000-4000-8000-000000000853";

const over = (query: () => Promise<{ rows: unknown }>) =>
  createInstitutionCourses((async (
    _token: string,
    fn: (tx: ActorTransaction) => Promise<unknown>,
  ) => fn({ query } as unknown as ActorTransaction)) as WithActor);

const hexGroup = fc.stringMatching(/^[0-9A-F]{4}$/);
const codeLike = fc.oneof(
  fc.string(),
  fc.tuple(hexGroup, hexGroup, hexGroup, hexGroup).map((g) => g.join("-")),
  fc
    .tuple(hexGroup, hexGroup, hexGroup, hexGroup, fc.string({ maxLength: 2 }))
    .map(([a, b, c, d, tail]) => `${a}-${b}-${c}-${d}${tail}`),
);

describe("issueEnrollmentCode properties", () => {
  it("an arbitrary thrown value is never issued and never escapes", async () => {
    await fc.assert(
      fc.asyncProperty(fc.anything(), async (thrown) => {
        const outcome = await over(() => Promise.reject(thrown)).issueEnrollmentCode(
          TOKEN,
          COURSE,
          "2026-12-01T10:00:00Z",
        );
        expect(outcome.status).not.toBe("issued");
      }),
    );
  });

  it("a returned string is issued exactly when it has the code's form", async () => {
    await fc.assert(
      fc.asyncProperty(codeLike, async (code) => {
        const outcome = await over(() => Promise.resolve({ rows: [{ code }] })).issueEnrollmentCode(
          TOKEN,
          COURSE,
          "2026-12-01T10:00:00Z",
        );
        expect(outcome.status === "issued").toBe(CODE.test(code));
        if (outcome.status === "issued") expect(outcome.code).toBe(code);
      }),
    );
  });
});

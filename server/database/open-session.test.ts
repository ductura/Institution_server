import { describe, expect, it } from "vitest";

import { affiliationArguments } from "./open-session.ts";

// SRV-1403: what the ten-argument identity.open_session receives as source
// and scope; the database decides again (pgTAP 187).
describe("affiliationArguments", () => {
  it("sends no affiliation without the fact, whatever is attached", () => {
    expect(affiliationArguments({ teacherEligible: false })).toStrictEqual([null, null]);
    expect(
      affiliationArguments({
        teacherEligible: false,
        staffAffiliation: { source: "eduPersonScopedAffiliation", scope: "demo.test" },
      }),
    ).toStrictEqual([null, null]);
  });

  it("sends the source, and the scope only for a scoped value", () => {
    expect(
      affiliationArguments({
        teacherEligible: true,
        staffAffiliation: { source: "eduPersonScopedAffiliation", scope: "demo.test" },
      }),
    ).toStrictEqual(["eduPersonScopedAffiliation", "demo.test"]);
    expect(
      affiliationArguments({
        teacherEligible: true,
        staffAffiliation: { source: "eduPersonAffiliation" },
      }),
    ).toStrictEqual(["eduPersonAffiliation", null]);
  });

  it("sends a bare fact as an unscoped hrEduPersonAffiliation value, as the older forms did", () => {
    expect(affiliationArguments({ teacherEligible: true })).toStrictEqual([
      "hrEduPersonAffiliation",
      null,
    ]);
  });
});

import { describe, expect, it } from "vitest";

import {
  STAFF_AFFILIATION_MISSING,
  STAFF_AFFILIATION_SOURCES,
  STAFF_EDU_PERSON_VALUES,
  staffAffiliationFromClaims,
} from "./affiliation.ts";
import { identityFromClaims } from "./claims.ts";

// SRV-1403 (M1.3, DAN-304): synthetic organisations and people only.
const HOME = "demo-fakultet.test";
const of = (claims: Record<string, unknown>, home = HOME) =>
  staffAffiliationFromClaims(claims, home);

describe("staffAffiliationFromClaims", () => {
  it("holds the closed sets the database checks again", () => {
    expect(STAFF_AFFILIATION_SOURCES).toStrictEqual([
      "hrEduPersonAffiliation",
      "eduPersonAffiliation",
      "eduPersonScopedAffiliation",
    ]);
    expect(STAFF_EDU_PERSON_VALUES).toStrictEqual(["employee", "faculty"]);
    expect(STAFF_AFFILIATION_MISSING).toBe("staff_affiliation_missing");
    expect(Object.isFrozen(STAFF_AFFILIATION_SOURCES)).toBe(true);
    expect(Object.isFrozen(STAFF_EDU_PERSON_VALUES)).toBe(true);
  });

  it("acceptance 2: a token without an affiliation gives none", () => {
    expect(of({})).toBeUndefined();
    expect(of({ hrEduPersonAffiliation: ["student"] })).toBeUndefined();
    expect(of({ eduPersonAffiliation: ["student", "member"] })).toBeUndefined();
    expect(of({ eduPersonScopedAffiliation: [`student@${HOME}`] })).toBeUndefined();
  });

  it("employee and faculty of the home organisation, scoped", () => {
    for (const value of STAFF_EDU_PERSON_VALUES) {
      expect(of({ eduPersonScopedAffiliation: [`${value}@${HOME}`] })).toStrictEqual({
        source: "eduPersonScopedAffiliation",
        scope: HOME,
      });
    }
    expect(of({ eduPersonScopedAffiliation: `faculty@${HOME}` })).toStrictEqual({
      source: "eduPersonScopedAffiliation",
      scope: HOME,
    });
  });

  it("acceptance 3: another institution's affiliation is refused", () => {
    for (const scope of ["drugi-fakultet.test", `${HOME}.drugi.test`, `x${HOME}`, `sub.${HOME}`]) {
      expect(of({ eduPersonScopedAffiliation: [`employee@${scope}`] })).toBeUndefined();
    }
    expect(
      of({ eduPersonScopedAffiliation: ["employee@drugi-fakultet.test", `faculty@${HOME}`] }),
    ).toStrictEqual({ source: "eduPersonScopedAffiliation", scope: HOME });
  });

  it("compares the scope as the home organisation, the value exactly", () => {
    expect(of({ eduPersonScopedAffiliation: [`employee@ ${HOME.toUpperCase()} `] })).toStrictEqual({
      source: "eduPersonScopedAffiliation",
      scope: HOME,
    });
    expect(of({ eduPersonScopedAffiliation: [`Employee@${HOME}`] })).toBeUndefined();
    expect(
      of({ eduPersonScopedAffiliation: [`employee@${HOME}`] }, ` ${HOME.toUpperCase()}`),
    ).toStrictEqual({
      source: "eduPersonScopedAffiliation",
      scope: HOME,
    });
    expect(of({ eduPersonScopedAffiliation: ["employee@"] })).toBeUndefined();
    expect(of({ eduPersonScopedAffiliation: [`@${HOME}`] })).toBeUndefined();
    expect(of({ eduPersonScopedAffiliation: [`employee@fak@${HOME}`] })).toBeUndefined();
    expect(
      of({ eduPersonScopedAffiliation: [`employee@${HOME}`] }, "nije domena!"),
    ).toBeUndefined();
  });

  it("the unscoped attributes describe the home organisation", () => {
    expect(of({ hrEduPersonAffiliation: ["student", "djelatnik"] })).toStrictEqual({
      source: "hrEduPersonAffiliation",
    });
    expect(of({ hrEduPersonAffiliation: "vanjski suradnik" })).toStrictEqual({
      source: "hrEduPersonAffiliation",
    });
    expect(of({ eduPersonAffiliation: ["member", "employee"] })).toStrictEqual({
      source: "eduPersonAffiliation",
    });
    expect(of({ eduPersonAffiliation: ["faculty"] })).toStrictEqual({
      source: "eduPersonAffiliation",
    });
  });

  it("prefers the scoped value, then hrEduPersonAffiliation", () => {
    expect(
      of({
        hrEduPersonAffiliation: ["djelatnik"],
        eduPersonAffiliation: ["employee"],
        eduPersonScopedAffiliation: [`employee@${HOME}`],
      }),
    ).toStrictEqual({ source: "eduPersonScopedAffiliation", scope: HOME });
    expect(
      of({ hrEduPersonAffiliation: ["djelatnik"], eduPersonAffiliation: ["employee"] }),
    ).toStrictEqual({
      source: "hrEduPersonAffiliation",
    });
    // An unscoped staff value of the home organisation stands next to a
    // scoped value of another one.
    expect(
      of({
        hrEduPersonAffiliation: ["djelatnik"],
        eduPersonScopedAffiliation: ["employee@drugi.test"],
      }),
    ).toStrictEqual({ source: "hrEduPersonAffiliation" });
  });

  it.each([
    ["an empty array", []],
    ["a hole", Array(1)],
    ["a hole before the value", [, `employee@${HOME}`]],
    ["a nested array", [[`employee@${HOME}`]]],
    ["an object", { employee: HOME }],
    ["a number", 42],
    ["a zero-width space", [`employee​@${HOME}`]],
    ["too many members", [...Array<string>(32).fill("member"), `employee@${HOME}`]],
  ])("%s gives no affiliation", (ignoredLabel, value) => {
    expect(of({ eduPersonScopedAffiliation: value, eduPersonAffiliation: value })).toBeUndefined();
  });
});

describe("the identity of a login", () => {
  const AAI = {
    sub: "sub-demo-1",
    hrEduPersonUniqueID: [`demo.nastavnik@${HOME}`],
    hrEduPersonHomeOrg: [HOME],
  };

  it("carries the affiliation exactly when the fact is true", () => {
    const staff = identityFromClaims({ ...AAI, eduPersonScopedAffiliation: [`faculty@${HOME}`] });
    expect(staff.ok && staff.identity).toMatchObject({
      teacherEligible: true,
      staffAffiliation: { source: "eduPersonScopedAffiliation", scope: HOME },
    });
    const other = identityFromClaims({
      ...AAI,
      eduPersonScopedAffiliation: ["faculty@drugi.test"],
    });
    expect(other.ok).toBe(true);
    expect(other.ok && other.identity.teacherEligible).toBe(false);
    expect(other.ok && "staffAffiliation" in other.identity).toBe(false);
  });

  it("takes the userinfo attributes over the ID token's", () => {
    const result = identityFromClaims(
      { ...AAI, eduPersonScopedAffiliation: [`employee@${HOME}`] },
      { sub: AAI.sub, eduPersonScopedAffiliation: ["employee@drugi.test"] },
    );
    expect(result.ok && result.identity.teacherEligible).toBe(false);
  });
});

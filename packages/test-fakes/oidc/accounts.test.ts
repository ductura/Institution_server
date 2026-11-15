// Ported from Ductus infra/fake-oidc/accounts.test.mjs (DAN-729): the same
// cases, node:test replaced by vitest.
import { expect, test } from "vitest";

import {
  DEMO_ACCOUNTS,
  DEMO_HOME_ORG,
  DEMO_HOME_ORG_B,
  demoAccountClaims,
  type DemoAccountClaims,
} from "./accounts.ts";

function claimsOf(id: string): DemoAccountClaims {
  const claims = demoAccountClaims(id);
  if (!claims) throw new Error(`no demo account ${id}`);
  return claims;
}

test("fake OIDC provides two distinct synthetic student accounts", () => {
  const students = Object.entries(DEMO_ACCOUNTS).filter(
    ([, account]) => account.affiliation === "student",
  );
  expect(students.map(([id]) => id)).toStrictEqual([
    "demo-student",
    "demo-student-2",
    "demo-b-student",
  ]);
  expect(new Set(students.map(([, account]) => account.name)).size).toBe(students.length);

  for (const [id, account] of students) {
    expect(demoAccountClaims(id)).toStrictEqual({
      sub: id,
      name: account.name,
      given_name: account.givenName,
      family_name: account.familyName,
      hrEduPersonUniqueID: [`${id}@${account.homeOrg}`],
      hrEduPersonHomeOrg: [account.homeOrg],
      hrEduPersonAffiliation: ["student"],
    });
  }
});

test("the synthetic teacher releases the staff affiliation, not an authorized role", () => {
  expect(demoAccountClaims("demo-teacher")).toStrictEqual({
    sub: "demo-teacher",
    name: "Demo nastavnik",
    given_name: "Petar",
    family_name: "Kranjčec",
    hrEduPersonUniqueID: [`demo-teacher@${DEMO_HOME_ORG}`],
    hrEduPersonHomeOrg: [DEMO_HOME_ORG],
    hrEduPersonAffiliation: ["djelatnik"],
  });
});

test("the second synthetic teacher is another staff member of the same home organization", () => {
  expect(demoAccountClaims("demo-teacher-2")).toStrictEqual({
    sub: "demo-teacher-2",
    name: "Demo nastavnica",
    given_name: "Maja",
    family_name: "Džombić",
    hrEduPersonUniqueID: [`demo-teacher-2@${DEMO_HOME_ORG}`],
    hrEduPersonHomeOrg: [DEMO_HOME_ORG],
    hrEduPersonAffiliation: ["djelatnik"],
  });
  // Playwright matches a button name as a case-insensitive substring: no
  // account name may contain another, or one click would find two buttons.
  const names = Object.values(DEMO_ACCOUNTS).map((account) => account.name.toLowerCase());
  for (const name of names)
    expect(names.filter((other) => other.includes(name)).length, name).toBe(1);
});

// DAN-483: the AAI@EduHr shape, one institution per account, and a second
// invented institution with its own staff member and student.
test("every demo account belongs to exactly one of the two invented institutions", () => {
  const orgs = new Set<string>();
  for (const [id, account] of Object.entries(DEMO_ACCOUNTS)) {
    const claims = claimsOf(id);
    for (const key of [
      "hrEduPersonUniqueID",
      "hrEduPersonHomeOrg",
      "hrEduPersonAffiliation",
    ] as const) {
      expect(Array.isArray(claims[key]) && claims[key].length === 1, `${id} ${key}`).toBe(true);
    }
    const [homeOrg] = claims.hrEduPersonHomeOrg;
    expect([DEMO_HOME_ORG, DEMO_HOME_ORG_B], id).toContain(homeOrg);
    expect(homeOrg, id).toBe(account.homeOrg);
    expect(claims.hrEduPersonUniqueID[0], id).toBe(`${id}@${homeOrg}`);
    expect(["student", "djelatnik"], id).toContain(claims.hrEduPersonAffiliation[0]);
    if (homeOrg !== undefined) orgs.add(homeOrg);
  }
  expect(DEMO_HOME_ORG).not.toBe(DEMO_HOME_ORG_B);
  expect(orgs.size).toBe(2);
  expect(claimsOf("demo-b-teacher").hrEduPersonAffiliation).toStrictEqual(["djelatnik"]);
  expect(claimsOf("demo-b-teacher").hrEduPersonHomeOrg).toStrictEqual([DEMO_HOME_ORG_B]);
  expect(claimsOf("demo-b-teacher-2").hrEduPersonAffiliation).toStrictEqual(["djelatnik"]);
  expect(claimsOf("demo-b-teacher-2").hrEduPersonHomeOrg).toStrictEqual([DEMO_HOME_ORG_B]);
  expect(claimsOf("demo-b-student").hrEduPersonAffiliation).toStrictEqual(["student"]);
  expect(claimsOf("demo-b-student").hrEduPersonHomeOrg).toStrictEqual([DEMO_HOME_ORG_B]);
});

// #757 D1: every demo account releases its given and family name as two
// separate strings under `profile`; the app never splits `name`.
test("every demo account has its own invented given and family name", () => {
  const pairs: string[] = [];
  for (const id of Object.keys(DEMO_ACCOUNTS)) {
    const claims = claimsOf(id);
    for (const key of ["given_name", "family_name"] as const) {
      expect(typeof claims[key], `${id} ${key}`).toBe("string");
      expect(claims[key], `${id} ${key}`).toBe(claims[key].trim());
      expect(claims[key].length > 0 && claims[key].length <= 255, `${id} ${key}`).toBe(true);
      expect(claims[key], `${id} ${key}`).not.toMatch(/\p{Cc}/u);
    }
    expect(claims.name, id).not.toBe(`${claims.given_name} ${claims.family_name}`);
    pairs.push(`${claims.given_name} ${claims.family_name}`);
  }
  expect(new Set(pairs).size).toBe(pairs.length);
  const surnames = Object.values(DEMO_ACCOUNTS).map((account) => account.familyName);
  expect(new Set(surnames).size).toBe(surnames.length);
  expect(surnames.some((surname) => /dž|lj|nj|[čćđšž]/i.test(surname))).toBe(true);
});

test("unknown and inherited object keys are not demo accounts", () => {
  expect(demoAccountClaims("not-a-demo-account")).toBeUndefined();
  expect(demoAccountClaims("constructor")).toBeUndefined();
});

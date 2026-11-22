// Simulated accounts of any institution's domain (Ductus#2028). Every name and
// domain is invented.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  isSimulatedDomain,
  parseSimulatedAccountId,
  parseSimulatedAccountsFile,
  readSimulatedAccountsFile,
  simulatedAccountClaims,
  simulatedAccountFromForm,
  simulatedAccountId,
  simulatedClaimsFor,
} from "./simulated-accounts.ts";

const form = (fields: Record<string, string>) => new URLSearchParams(fields);

describe("the login form's account", () => {
  it("takes a domain and a role; an empty user name is the role's name", () => {
    const account = simulatedAccountFromForm(
      form({ domena: " Primjer-Fakultet.test ", uloga: "student", korisnik: "" }),
    );
    expect(account).toEqual({
      role: "student",
      user: "student",
      domain: "primjer-fakultet.test",
      givenName: "Simulirani",
      familyName: "Student",
    });
    expect(account && simulatedAccountId(account)).toBe(
      "sim:student:student@primjer-fakultet.test",
    );
  });

  it("a teacher is released as djelatnik, in the AAI@EduHr shape", () => {
    const account = simulatedAccountFromForm(
      form({ domena: "b.primjer.test", uloga: "nastavnik", korisnik: "ana.k" }),
    );
    expect(account && simulatedAccountClaims(account)).toEqual({
      sub: "sim:nastavnik:ana.k@b.primjer.test",
      name: "Simulirani Nastavnik",
      given_name: "Simulirani",
      family_name: "Nastavnik",
      hrEduPersonUniqueID: ["ana.k@b.primjer.test"],
      hrEduPersonHomeOrg: ["b.primjer.test"],
      hrEduPersonAffiliation: ["djelatnik"],
    });
  });

  it.each([
    [{ domena: "localhost", uloga: "student" }],
    [{ domena: "a..b", uloga: "student" }],
    [{ domena: "-a.test", uloga: "student" }],
    [{ domena: `${"a".repeat(64)}.test`, uloga: "student" }],
    [{ domena: "x.test", uloga: "admin" }],
    [{ domena: "x.test", uloga: "toString" }],
    [{ domena: "x.test" }],
    [{ domena: "x.test", uloga: "student", korisnik: "a@b" }],
    [{ domena: "x.test", uloga: "student", korisnik: "a b" }],
    [{ domena: "x.test", uloga: "student", korisnik: ".a" }],
  ])("refuses %j", (fields) => {
    expect(simulatedAccountFromForm(form(fields))).toBeUndefined();
  });
});

describe("account ids", () => {
  it("round-trip, and anything else is no account", () => {
    expect(parseSimulatedAccountId("sim:student:iva@x.test")).toMatchObject({
      role: "student",
      user: "iva",
      domain: "x.test",
    });
    for (const id of [
      undefined,
      "demo-student",
      "sim:student:iva@localhost",
      "sim:admin:iva@x.test",
      "sim:student:@x.test",
      "sim:student:a@b@x.test",
      "sim:student:IVA@x.test",
    ])
      expect(parseSimulatedAccountId(id)).toBeUndefined();
    expect(isSimulatedDomain("fpzg.hr")).toBe(true);
    expect(isSimulatedDomain("FPZG.hr")).toBe(false);
  });

  it("a file account keeps its own names; a typed one with the same id would too", () => {
    const [named] = parseSimulatedAccountsFile({
      racuni: [
        { korisnik: "iva", domena: "x.test", uloga: "student", ime: "Iva", prezime: "Ćorić" },
      ],
    });
    expect(simulatedClaimsFor("sim:student:iva@x.test", named ? [named] : [])).toMatchObject({
      given_name: "Iva",
      family_name: "Ćorić",
    });
    expect(simulatedClaimsFor("sim:student:ivo@x.test", named ? [named] : [])).toMatchObject({
      given_name: "Simulirani",
    });
    expect(simulatedClaimsFor("demo-student", [])).toBeUndefined();
  });
});

describe("the accounts file", () => {
  it.each([
    [[], "root is not an object"],
    [{ racuni: [], x: 1 }, 'exactly one key, "racuni"'],
    [{ racuni: {} }, "racuni is not an array"],
    [{ racuni: [1] }, "racuni[0] is not an object"],
    [{ racuni: [{ korisnik: "a", domena: "x.test", uloga: "student", e: 1 }] }, "unknown key"],
    [{ racuni: [{ korisnik: "a", domena: "x", uloga: "student" }] }, "domena"],
    [{ racuni: [{ korisnik: "a", domena: "x.test", uloga: "dekan" }] }, "uloga"],
    [{ racuni: [{ korisnik: "A", domena: "x.test", uloga: "student" }] }, "korisnik"],
    [{ racuni: [{ korisnik: "a", domena: "x.test", uloga: "student", ime: "<b>" }] }, "ime"],
    [{ racuni: [{ korisnik: "a", domena: "x.test", uloga: "student", prezime: 1 }] }, "prezime"],
    [
      {
        racuni: [
          { korisnik: "a", domena: "x.test", uloga: "student" },
          { korisnik: "a", domena: "x.test", uloga: "student" },
        ],
      },
      "repeats",
    ],
  ])("refuses %j", (input, message) => {
    expect(() => parseSimulatedAccountsFile(input)).toThrow(message);
  });

  it("reads a file; no path is no accounts; a broken file stops the provider", () => {
    const dir = mkdtempSync(join(tmpdir(), "oidc-racuni-"));
    try {
      const file = join(dir, "racuni.json");
      writeFileSync(
        file,
        JSON.stringify({ racuni: [{ korisnik: "a", domena: "x.test", uloga: "nastavnik" }] }),
      );
      expect(readSimulatedAccountsFile(file)).toHaveLength(1);
      expect(readSimulatedAccountsFile(undefined)).toEqual([]);
      expect(readSimulatedAccountsFile(" ")).toEqual([]);
      writeFileSync(file, "{");
      expect(() => readSimulatedAccountsFile(file)).toThrow("not JSON");
      expect(() => readSimulatedAccountsFile(join(dir, "nema.json"))).toThrow("ENOENT");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

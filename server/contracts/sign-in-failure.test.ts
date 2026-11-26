// Where a failed login ends (DAN-1081): the data @ductura/contracts publishes
// as auth/sign-in-failure.json, read strictly, with a text for each code.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { messagesEn, messagesHr, textOf, type MessageKey } from "../../locales/index.ts";
import { CONTRACTS as MANIFEST_CONTRACTS } from "../../scripts/release/index.ts";
import { readSignInFailure, SIGN_IN_FAILURE } from "./routes/index.ts";

const FILE = new URL("./routes/sign-in-failure.json", import.meta.url);
const raw = (): Record<string, unknown> =>
  JSON.parse(readFileSync(FILE, "utf8")) as Record<string, unknown>;

describe("auth/sign-in-failure.json", () => {
  it("is the page, the parameter and exactly two codes", () => {
    expect(SIGN_IN_FAILURE).toEqual({
      page: "/aplikacija/prijava",
      param: "greska",
      codes: [
        { code: "login_failed", messageKey: "auth.failedBody" },
        { code: "provider_unavailable", messageKey: "auth.unavailableBody" },
      ],
    });
    expect(readSignInFailure(raw())).toEqual(SIGN_IN_FAILURE);
    expect(Object.isFrozen(SIGN_IN_FAILURE.codes[0])).toBe(true);
  });

  it("names a text in both languages for every code", () => {
    for (const { messageKey } of SIGN_IN_FAILURE.codes) {
      for (const table of [messagesHr, messagesEn]) {
        expect(textOf(table, messageKey as MessageKey), messageKey).toMatch(/\S/u);
      }
    }
  });

  const codes = () => (raw().codes as Record<string, unknown>[]).map((c) => ({ ...c }));
  it.each<[string, (data: Record<string, unknown>) => void]>([
    ["a stray key", (d) => (d.extra = 1)],
    ["another format", (d) => (d.format = "ductura-sign-in-failure-v2")],
    ["another page", (d) => (d.page = "//aplikacija/prijava")],
    ["a parameter that is not a plain word", (d) => (d.param = "greska&x=1")],
    ["a third code", (d) => (d.codes = [...codes(), { code: "no_role", messageKey: "x" }])],
    ["one code", (d) => (d.codes = codes().slice(0, 1))],
    ["the codes swapped", (d) => (d.codes = codes().reverse())],
    ["the same code twice", (d) => (d.codes = [codes()[0], codes()[0]])],
    ["a code with a stray key", (d) => (d.codes = [{ ...codes()[0], x: 1 }, codes()[1]])],
    ["a key that is not text", (d) => (d.codes = [{ ...codes()[0], messageKey: 1 }, codes()[1]])],
    ["codes that are not a list", (d) => (d.codes = { 0: codes()[0], 1: codes()[1] })],
  ])("refuses %s", (_name, edit) => {
    const data = raw();
    edit(data);
    expect(() => readSignInFailure(data)).toThrow(/^sign-in-failure\.json: /u);
  });

  it("refuses what is not an object", () => {
    for (const value of [null, [], "x", 1]) expect(() => readSignInFailure(value)).toThrow();
  });

  it("is published with @ductura/contracts", () => {
    expect(MANIFEST_CONTRACTS.dataExports["./auth/sign-in-failure.json"]).toBe(
      "./auth/sign-in-failure.json",
    );
    expect(MANIFEST_CONTRACTS.data["auth/sign-in-failure.json"]).toBe(
      "server/contracts/routes/sign-in-failure.json",
    );
    expect(MANIFEST_CONTRACTS.files).toContain("auth/sign-in-failure.json");
  });
});

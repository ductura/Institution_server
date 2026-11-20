// SRV-1101: the text checks and Lekta profile of an institution (invented ids only).
import { describe, expect, it } from "vitest";

import { LEKTA_PROFILE_IDS } from "./lekta-profiles.ts";
import { enabledCheckIdsFor, lektaProfileOf, TEXT_CHECK_IDS } from "./text-check-rules.ts";

describe("text check ids", () => {
  it("are the kinds of the editor prototype, each once", () => {
    expect([...TEXT_CHECK_IDS].sort()).toEqual(
      [
        "absolute",
        "abbr",
        "claim",
        "colloq",
        "first",
        "hole",
        "long",
        "passive",
        "paste",
        "short",
        "term",
        "trans",
      ].sort(),
    );
    expect(new Set(TEXT_CHECK_IDS).size).toBe(TEXT_CHECK_IDS.length);
  });
});

describe("enabledCheckIdsFor", () => {
  it("gives the prototype defaults without a profile", () => {
    expect(enabledCheckIdsFor(null)).toEqual(["paste", "claim", "long", "term", "abbr", "hole"]);
  });

  it("adds the register checks for an institution with a profile, in list order", () => {
    expect(enabledCheckIdsFor("agr-diplomski")).toEqual([
      "paste",
      "claim",
      "long",
      "colloq",
      "absolute",
      "first",
      "term",
      "abbr",
      "hole",
    ]);
  });

  it("differs between two institutions that differ in the profile", () => {
    expect(enabledCheckIdsFor("agr-diplomski")).not.toEqual(enabledCheckIdsFor(null));
  });
});

describe("lektaProfileOf", () => {
  it("returns a catalogue profile and null for anything else", () => {
    expect(lektaProfileOf(LEKTA_PROFILE_IDS[0])).toBe(LEKTA_PROFILE_IDS[0]);
    for (const value of [undefined, null, "", "nepoznat-profil", 7, {}, "toString", "__proto__"])
      expect(lektaProfileOf(value)).toBeNull();
  });
});

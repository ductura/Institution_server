import { describe, expect, it } from "vitest";

import { BANNED_JURISDICTIONS, parseProviderEntry, parseProviderList } from "./provider-rules.ts";

// Invented provider and model only (S4, O-1): no real name appears here.
const ENTRY = {
  providerId: "provider-test-a",
  modelId: "model-test-1",
  headquarters: "HR",
  modelDeveloperHeadquarters: "FR",
  processingCountries: ["DE", "HR"],
};

describe("provider ban of D-194 t. 2 (P8)", () => {
  it("loads an entry outside every banned jurisdiction", () => {
    expect(parseProviderEntry(ENTRY)).toEqual({ ok: true, entry: ENTRY });
  });

  it("covers China with Hong Kong and Macau, as a frozen list in code", () => {
    expect(BANNED_JURISDICTIONS).toEqual(["CN", "HK", "MO"]);
    expect(Object.isFrozen(BANNED_JURISDICTIONS)).toBe(true);
  });

  it.each(BANNED_JURISDICTIONS.map((code) => [code]))(
    "refuses %s on each of the three facts",
    (code) => {
      expect(parseProviderEntry({ ...ENTRY, headquarters: code })).toEqual({
        ok: false,
        rule: "banned_provider_headquarters",
      });
      // A model of a Chinese company served by a European provider.
      expect(parseProviderEntry({ ...ENTRY, modelDeveloperHeadquarters: code })).toEqual({
        ok: false,
        rule: "banned_model_developer",
      });
      expect(parseProviderEntry({ ...ENTRY, processingCountries: ["DE", code] })).toEqual({
        ok: false,
        rule: "banned_processing_location",
      });
    },
  );

  it("one banned entry refuses the whole faculty list", () => {
    const second = { ...ENTRY, providerId: "provider-test-b", processingCountries: ["CN"] };
    expect(parseProviderList([ENTRY, second])).toEqual({
      ok: false,
      rule: "banned_processing_location",
      index: 1,
    });
    expect(parseProviderList([ENTRY])).toEqual({ ok: true, entries: [ENTRY] });
    expect(parseProviderList([])).toEqual({ ok: true, entries: [] });
    expect(parseProviderList({ 0: ENTRY })).toEqual({
      ok: false,
      rule: "invalid_entry",
      index: -1,
    });
  });

  it("a flag that would switch the ban off is an unknown key", () => {
    for (const extra of [{ allowBanned: true }, { exception: "faculty" }, { region: "eu" }])
      expect(parseProviderEntry({ ...ENTRY, headquarters: "CN", ...extra })).toEqual({
        ok: false,
        rule: "invalid_entry",
      });
  });

  it("refuses a bad shape before reading the ban", () => {
    for (const bad of [
      { ...ENTRY, providerId: "Provider A" },
      { ...ENTRY, modelId: "" },
      { ...ENTRY, headquarters: "cn" },
      { ...ENTRY, headquarters: "CHN" },
      { ...ENTRY, processingCountries: [] },
      { ...ENTRY, processingCountries: "DE" },
      { ...ENTRY, processingCountries: ["DE", 1] },
      { ...ENTRY, modelDeveloperHeadquarters: undefined },
      null,
      [ENTRY],
    ])
      expect(parseProviderEntry(bad)).toEqual({ ok: false, rule: "invalid_entry" });
  });
});

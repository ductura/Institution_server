import { HOSTILE_JSON } from "@ductura/test-fakes/hostile-inputs";
import { describe, expect, it } from "vitest";

import { parseTsaConfig, PILOT_TSA_CONFIG, TSA_CONFIG_FORMAT } from "./index.ts";

const INVALID = {
  ok: false,
  error: { code: "TSA_CONFIG_INVALID", messageKey: "tsa.config_invalid" },
};
const base = (): Record<string, unknown> =>
  JSON.parse(JSON.stringify(PILOT_TSA_CONFIG)) as Record<string, unknown>;
const withTsas = (tsas: unknown): Record<string, unknown> => ({ ...base(), tsas });
const entry = (over: Record<string, unknown> = {}) => ({
  id: "fina",
  url: "https://tsa.fina.invalid/tsa",
  timeoutMs: 1000,
  ...over,
});

describe("PILOT_TSA_CONFIG", () => {
  it("is DigiCert and Sectigo only (D-72, D-209; O-1 (b): no FINA in the pilot)", () => {
    expect(PILOT_TSA_CONFIG.tsas.map((t) => t.id)).toEqual(["digicert", "sectigo"]);
    expect(parseTsaConfig(base())).toEqual({ ok: true, value: PILOT_TSA_CONFIG });
  });

  it("a third TSA is a configuration change only (O-1 (b))", () => {
    const result = parseTsaConfig(withTsas([...PILOT_TSA_CONFIG.tsas, entry()]));
    expect(result.ok && result.value.tsas.map((t) => t.id)).toEqual([
      "digicert",
      "sectigo",
      "fina",
    ]);
  });
});

describe("parseTsaConfig refuses", () => {
  const cases: [string, unknown][] = [
    ["a non-object", "tsas"],
    ["null", null],
    ["an array", []],
    ["another format", { ...base(), format: "ductura-tsa-v2" }],
    ["an unknown key", { ...base(), fallback: "x" }],
    ["no TSA", withTsas([])],
    ["more than five TSAs", withTsas([1, 2, 3, 4, 5, 6].map((n) => entry({ id: `t${n}` })))],
    ["a duplicate id", withTsas([entry(), entry()])],
    ["an id that is not kebab-case", withTsas([entry({ id: "Fina_TSA" })])],
    ["an unknown entry key", withTsas([entry({ secret: "x" })])],
    ["an ftp URL", withTsas([entry({ url: "ftp://tsa.fina.invalid/" })])],
    ["a javascript URL", withTsas([entry({ url: "javascript:alert(1)" })])],
    ["credentials in the URL", withTsas([entry({ url: "https://user:pw@tsa.fina.invalid/" })])],
    ["a fragment", withTsas([entry({ url: "https://tsa.fina.invalid/#x" })])],
    ["a relative URL", withTsas([entry({ url: "/tsa" })])],
    ["timeout 0", withTsas([entry({ timeoutMs: 0 })])],
    ["a fractional timeout", withTsas([entry({ timeoutMs: 1.5 })])],
    ["maxAttempts 0", { ...base(), maxAttempts: 0 }],
    ["maxAttempts 11", { ...base(), maxAttempts: 11 }],
    ["a negative backoff", { ...base(), initialBackoffMs: -1 }],
    ["a string skew", { ...base(), clockSkewMs: "120000" }],
    ["a skew above ten minutes", { ...base(), clockSkewMs: 600_001 }],
  ];
  it.each(cases)("%s", (_, raw) => {
    expect(parseTsaConfig(raw)).toEqual(INVALID);
  });

  it("every hostile JSON value", () => {
    for (const { text } of HOSTILE_JSON) {
      const hostile: unknown = JSON.parse(text);
      expect(parseTsaConfig(hostile)).toEqual(INVALID);
      expect(parseTsaConfig({ format: TSA_CONFIG_FORMAT, ...base(), tsas: [hostile] })).toEqual(
        INVALID,
      );
    }
  });
});

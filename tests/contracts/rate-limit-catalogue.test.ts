// DAN-814 (Ductus#1836 c.6908215789): server/traffic may not import
// server/domain, so the defaults and bounds of the rate limit are held equal to
// the settings catalogue here (N14). A cross-area test, as
// settings-catalogue.test.ts.
import { describe, expect, it } from "vitest";

import { SETTINGS_CATALOGUE } from "../../server/domain/index.ts";
import {
  checkRateLimits,
  DEFAULT_RATE_LIMITS,
  RATE_LIMIT_CLASSES,
} from "../../server/traffic/index.ts";

const entry = (key: string) => SETTINGS_CATALOGUE.find((definition) => definition.key === key);

describe("rate limit and settings catalogue", () => {
  it("every limit has a network_security integer key whose default is the limiter's", () => {
    const keys: string[] = [];
    for (const name of RATE_LIMIT_CLASSES) {
      const own = DEFAULT_RATE_LIMITS[name];
      const pairs: [string, number | null][] = [
        ["per_ip", own.perIp],
        ["per_account", own.perAccount],
      ];
      for (const [kind, value] of pairs) {
        const key = `network.rate_limit_${name}_${kind}`;
        if (value === null) {
          expect(entry(key), key).toBeUndefined();
          continue;
        }
        keys.push(key);
        expect(entry(key), key).toEqual({
          key,
          levels: ["network_security"],
          kind: "integer",
          default: value,
          min: 1,
          max: 100_000,
        });
      }
    }
    const inCatalogue = SETTINGS_CATALOGUE.filter((d) => d.key.startsWith("network.rate_limit_"));
    expect(inCatalogue.map((d) => d.key).sort()).toEqual(keys.sort());
  });

  it("the catalogue's hard limits are the limiter's", () => {
    const at = (perIp: number) =>
      checkRateLimits({ ...DEFAULT_RATE_LIMITS, default: { perIp, perAccount: 300 } });
    expect(at(1)).not.toBeNull();
    expect(at(100_000)).not.toBeNull();
    expect(at(0)).toBeNull();
    expect(at(100_001)).toBeNull();
  });
});

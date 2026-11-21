import { expect, it } from "vitest";

import { DEFAULT_RATE_LIMITS } from "../../traffic/index.ts";
import { readRateLimitConfig } from "./index.ts";

const KEY = "DUCTURA_RATE_LIMIT_SAVE_PER_ACCOUNT";

it("uses the catalogue defaults for unset limits", () => {
  expect(readRateLimitConfig({})).toEqual({ limits: DEFAULT_RATE_LIMITS, problems: [] });
});

it.each(["1", "100000"])("accepts a configurable limit of %s", (value) => {
  const { limits, problems } = readRateLimitConfig({ [KEY]: value });
  expect(limits.save.perAccount).toBe(Number(value));
  expect(problems).toEqual([]);
});

it.each(["", "0", "100001", " 1", "1.0", "1e2", "-1"])(
  "reports an invalid limit without logging its value (%j)",
  (value) => {
    expect(readRateLimitConfig({ [KEY]: value }).problems).toEqual([
      `${KEY} must be an integer between 1 and 100000`,
    ]);
  },
);

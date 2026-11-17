import { describe, expect, it } from "vitest";

import { isNonProductionBuild, testModeProblems } from "./index.ts";

// S-1H.7 (DAN-938-1): DUCTURA_MODE=test is refused in production. Values are
// invented; the canary stands in for anything that must not reach a log.
const CANARY = "invented-canary-938";
const REFUSED = "DUCTURA_MODE test is refused in production";
const UNKNOWN = "DUCTURA_MODE is not a known mode";

describe("testModeProblems", () => {
  it.each([
    [undefined],
    ["production"],
    [""],
    ["Test"],
    ["test\n"],
    [" test"],
    ["development "],
    [CANARY],
  ])("refuses DUCTURA_MODE test with NODE_ENV %j, by name only", (nodeEnv) => {
    const env =
      nodeEnv === undefined
        ? { DUCTURA_MODE: "test" }
        : { DUCTURA_MODE: "test", NODE_ENV: nodeEnv };
    const problems = testModeProblems(env);
    expect(problems).toEqual([REFUSED]);
    expect(problems.join(" ")).not.toContain(CANARY);
  });

  it.each([["development"], ["test"]])("allows DUCTURA_MODE test with NODE_ENV %s", (nodeEnv) => {
    expect(testModeProblems({ DUCTURA_MODE: "test", NODE_ENV: nodeEnv })).toEqual([]);
  });

  it("is silent without DUCTURA_MODE, in production too", () => {
    expect(testModeProblems({})).toEqual([]);
    expect(testModeProblems({ NODE_ENV: "production" })).toEqual([]);
  });

  it.each([
    "",
    "Test",
    "TEST",
    " test",
    "test ",
    "test\r\n",
    "test\n",
    "test\t",
    "test ",
    "test\u007f",
    "test\u0000",
    "​test",
    "tеst",
    "production",
    `test${CANARY}`,
  ])("refuses DUCTURA_MODE %j as unknown under every NODE_ENV", (mode) => {
    for (const nodeEnv of ["test", "development", "production", undefined]) {
      const env =
        nodeEnv === undefined ? { DUCTURA_MODE: mode } : { DUCTURA_MODE: mode, NODE_ENV: nodeEnv };
      const problems = testModeProblems(env);
      expect(problems, String(nodeEnv)).toEqual([UNKNOWN]);
      expect(problems.join(" ")).not.toContain(CANARY);
    }
  });

  it("reads own properties only: an inherited NODE_ENV test does not open the mode", () => {
    const env = Object.assign(Object.create({ NODE_ENV: "test" }) as Record<string, string>, {
      DUCTURA_MODE: "test",
    });
    expect(testModeProblems(env)).toEqual([REFUSED]);
  });

  it("reads own properties only: an inherited DUCTURA_MODE does not turn the mode on", () => {
    const env = Object.create({ DUCTURA_MODE: "invented" }) as Record<string, string>;
    expect(testModeProblems(env)).toEqual([]);
  });

  it("refuses a getter or a non-string value without calling the getter", () => {
    let called = false;
    const getter = Object.defineProperty({ NODE_ENV: "test" }, "DUCTURA_MODE", {
      enumerable: true,
      get: () => {
        called = true;
        return "test";
      },
    });
    expect(testModeProblems(getter)).toEqual([UNKNOWN]);
    expect(called).toBe(false);
    const nodeGetter = Object.defineProperty({ DUCTURA_MODE: "test" }, "NODE_ENV", {
      enumerable: true,
      get: () => {
        called = true;
        return "test";
      },
    });
    expect(testModeProblems(nodeGetter)).toEqual([REFUSED]);
    expect(called).toBe(false);
    expect(testModeProblems({ DUCTURA_MODE: 1 } as unknown as Record<string, string>)).toEqual([
      UNKNOWN,
    ]);
  });

  it("ignores keys that only look special", () => {
    const parsed = JSON.parse(
      '{"__proto__": {"NODE_ENV": "test"}, "toString": "test", "constructor": "test", "DUCTURA_MODE": "test"}',
    ) as Record<string, string>;
    expect(testModeProblems(parsed)).toEqual([REFUSED]);
  });
});

describe("isNonProductionBuild", () => {
  it("is an allowlist: only development and test", () => {
    expect(isNonProductionBuild("development")).toBe(true);
    expect(isNonProductionBuild("test")).toBe(true);
    for (const value of [undefined, "", "production", "Test", "test ", "toString", "__proto__"]) {
      expect(isNonProductionBuild(value), String(value)).toBe(false);
    }
  });
});

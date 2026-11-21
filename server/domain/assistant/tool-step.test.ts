// The record of one tool request (S3-D3, S3-D4, S3-I2). All names, queries and
// arguments are invented.
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { TOOL_STEP_MAX } from "./instructions.ts";
import { planToolCall, stepsOf } from "./tool-step.ts";
import { QUERY_MAX } from "./tools.ts";

const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

describe("planToolCall", () => {
  it("a valid web_search call keeps only hashes and the checked query", () => {
    const planned = planToolCall(
      { name: "web_search", args: { query: "kompostiranje u gradu" } },
      sha,
    );
    expect(planned).toEqual({
      toolName: "web_search",
      requestedNameSha256: sha("web_search"),
      argsSha256: sha('{"query":"kompostiranje u gradu"}'),
      argsValid: true,
      query: "kompostiranje u gradu",
    });
  });

  it("maps every look-alike name to null and keeps only its hash", () => {
    for (const name of [
      "Web_search",
      " web_search",
      "web_search ",
      "web​search",
      "wеb_search",
      "",
    ]) {
      const planned = planToolCall({ name, args: { query: "upit" } }, sha);
      expect(planned.toolName).toBeNull();
      expect(planned.argsValid).toBe(false);
      expect(planned.query).toBeNull();
      expect(planned.requestedNameSha256).toBe(sha(name));
      expect(JSON.stringify(planned)).not.toContain('"upit"');
    }
  });

  it("a name that is not a string still hashes and maps to null", () => {
    const planned = planToolCall({ name: { evil: true } as unknown as string, args: {} }, sha);
    expect(planned.toolName).toBeNull();
    expect(planned.requestedNameSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("arguments outside the closed schema are invalid, at the limit and one over", () => {
    for (const args of [
      null,
      {},
      { query: 1 },
      { query: "" },
      { query: "x", url: "https://a.invalid" },
      [],
      "x",
    ])
      expect(planToolCall({ name: "web_search", args }, sha).argsValid).toBe(false);
    expect(
      planToolCall({ name: "web_search", args: { query: "a".repeat(QUERY_MAX) } }, sha).argsValid,
    ).toBe(true);
    expect(
      planToolCall({ name: "web_search", args: { query: "a".repeat(QUERY_MAX + 1) } }, sha)
        .argsValid,
    ).toBe(false);
  });

  it("arguments that JSON cannot hold still hash", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    const planned = planToolCall({ name: "web_search", args: cyclic }, sha);
    expect(planned.argsValid).toBe(false);
    expect(planned.argsSha256).toBe(sha("unserialisable"));
    expect(planToolCall({ name: "web_search", args: undefined }, sha).argsSha256).toBe(
      sha("undefined"),
    );
  });
});

describe("stepsOf (S3-I2)", () => {
  const call = { name: "web_search", args: { query: "upit" } };

  it("one call is one step, also when one output asks for several", () => {
    expect(stepsOf([call, call], 1, TOOL_STEP_MAX, sha)).toMatchObject({ overLimit: false });
    expect(stepsOf([call, call], 1, TOOL_STEP_MAX, sha).steps).toHaveLength(2);
  });

  it("at the limit everything fits; one more is over the limit", () => {
    expect(stepsOf([call], TOOL_STEP_MAX, TOOL_STEP_MAX, sha)).toMatchObject({ overLimit: false });
    expect(stepsOf([call], TOOL_STEP_MAX + 1, TOOL_STEP_MAX, sha)).toMatchObject({
      overLimit: true,
    });
    expect(stepsOf([call, call], TOOL_STEP_MAX, TOOL_STEP_MAX, sha).overLimit).toBe(true);
  });
});

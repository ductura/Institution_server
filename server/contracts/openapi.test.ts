import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { baseDocument } from "../../scripts/check-breaking.ts";
import { OPENAPI_FILE, openapiJson } from "../../scripts/generate-contracts.ts";
import { API_PREFIX } from "./schema.ts";
import { API_VERSION } from "./version.ts";

describe("published OpenAPI v1", () => {
  it("openapi/v1.json matches a fresh run, byte for byte", () => {
    expect(readFileSync(OPENAPI_FILE, "utf8")).toBe(openapiJson());
  });

  it("the version is major.minor.patch and its major names the path prefix and the file", () => {
    expect(API_VERSION).toMatch(/^1\.\d+\.\d+$/);
    const major = API_VERSION.split(".")[0];
    expect(API_PREFIX).toBe(`/api/v${major}`);
    expect(OPENAPI_FILE.endsWith(`openapi/v${major}.json`)).toBe(true);
    expect((JSON.parse(openapiJson()) as { info: { version: unknown } }).info.version).toBe(API_VERSION);
  });

  it("is not also written into server/contracts/generated", () => {
    expect(existsSync(new URL("./generated/openapi.json", import.meta.url))).toBe(false);
  });
});

describe("base document for the CI check", () => {
  const files = (present: Record<string, string>) => (spec: string) => present[spec] ?? null;

  it("reads openapi/v1.json, else the generated file of the revision before it, else nothing", () => {
    expect(baseDocument("b", files({ "b:openapi/v1.json": '{"a":1}', "b:server/contracts/generated/openapi.json": '{"a":2}' }))).toEqual({ a: 1 });
    expect(baseDocument("b", files({ "b:server/contracts/generated/openapi.json": '{"a":2}' }))).toEqual({ a: 2 });
    expect(baseDocument("b", files({}))).toBeNull();
  });
});

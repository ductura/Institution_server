import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { OPENAPI_FILE, openapiJson, toPosix } from "../../scripts/index.ts";
import { API_PREFIX, API_VERSION } from "./index.ts";

describe("published OpenAPI v1", () => {
  it("openapi/v1.json matches a fresh run, byte for byte", () => {
    expect(readFileSync(OPENAPI_FILE, "utf8")).toBe(openapiJson());
  });

  it("the version is major.minor.patch and its major names the path prefix and the file", () => {
    expect(API_VERSION).toMatch(/^1\.\d+\.\d+$/);
    const major = API_VERSION.split(".")[0];
    expect(API_PREFIX).toBe(`/api/v${major}`);
    expect(toPosix(OPENAPI_FILE).endsWith(`openapi/v${major}.json`)).toBe(true);
    expect((JSON.parse(openapiJson()) as { info: { version: unknown } }).info.version).toBe(
      API_VERSION,
    );
  });

  it("is not also written into server/contracts/generated", () => {
    expect(existsSync(new URL("./generated/openapi.json", import.meta.url))).toBe(false);
  });
});

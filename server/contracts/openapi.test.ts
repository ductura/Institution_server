import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { OPENAPI_FILE, openapiJson, toPosix } from "../../scripts/index.ts";
import { API_PREFIX, API_VERSION, SHARED_ERROR_HEADERS, SHARED_ERRORS } from "./index.ts";

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

  // Review on DAN-814 b: a shared error (500 internal, 429 too_many_requests) is
  // answered on every route, so the published document must name it. v1 cannot add
  // a status under an existing route (breaking.ts), so info.description lists them.
  it("names every shared error with its key and headers in info.description", () => {
    const { info } = JSON.parse(readFileSync(OPENAPI_FILE, "utf8")) as {
      info: { description?: string };
    };
    const lines = (info.description ?? "").split("\n");
    expect(SHARED_ERRORS.length).toBeGreaterThanOrEqual(2);
    for (const error of SHARED_ERRORS) {
      const line = lines.find((l) => l.startsWith(`- ${error.status} ${error.code}:`));
      expect(line, `${error.status} ${error.code}`).toBeDefined();
      expect(line).toContain(`messageKey: "${error.key}"`);
      for (const header of SHARED_ERROR_HEADERS[`${error.status} ${error.code}`] ?? [])
        expect(line).toContain(`header ${header}`);
    }
    expect(lines.filter((l) => l.startsWith("- "))).toHaveLength(SHARED_ERRORS.length);
    expect(SHARED_ERROR_HEADERS["429 too_many_requests"]).toEqual(["retry-after"]);
  });
});

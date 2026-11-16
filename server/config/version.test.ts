import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { SERVER_VERSION } from "./version.ts";

const MANIFEST = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { version: string };

describe("SERVER_VERSION", () => {
  it("is the version of package.json, major.minor.patch", () => {
    expect(SERVER_VERSION).toBe(MANIFEST.version);
    expect(SERVER_VERSION).toMatch(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u);
  });
});

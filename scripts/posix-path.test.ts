import { describe, expect, it } from "vitest";

import { toPosix } from "./posix-path.ts";

describe("toPosix", () => {
  it("turns Windows separators into forward slashes", () => {
    expect(toPosix("C:\\work\\server\\openapi\\v1.json")).toBe("C:/work/server/openapi/v1.json");
  });

  it("leaves a POSIX path unchanged", () => {
    expect(toPosix("/work/server/openapi/v1.json")).toBe("/work/server/openapi/v1.json");
  });

  it("makes a Windows OPENAPI_FILE end with the repository path", () => {
    expect("C:\\work\\server\\openapi\\v1.json".endsWith("openapi/v1.json")).toBe(false);
    expect(toPosix("C:\\work\\server\\openapi\\v1.json").endsWith("openapi/v1.json")).toBe(true);
  });
});

// DAN-851-2c2: the public interface of server/support (docs/server-map.md).
import { describe, expect, it } from "vitest";
import * as area from "./index.ts";

describe("server/support public interface", () => {
  it("exports the service factory and its errors", () => {
    expect(Object.keys(area).sort()).toEqual([
      "PROBLEM_REPORT_INVALID_BODY",
      "PROBLEM_REPORT_INVALID_JSON",
      "SUPPORT_ERRORS",
      "createSupportService",
    ]);
  });
});

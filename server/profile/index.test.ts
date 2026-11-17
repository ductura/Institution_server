// DAN-851-1c2: the public interface of server/profile (docs/server-map.md).
import { describe, expect, it } from "vitest";
import * as area from "./index.ts";

describe("server/profile public interface", () => {
  it("exports the service factory and its errors", () => {
    expect(Object.keys(area).sort()).toEqual([
      "INTERFACE_LOCALE_INVALID_BODY",
      "INTERFACE_LOCALE_INVALID_JSON",
      "PROFILE_ERRORS",
      "createProfileService",
    ]);
  });
});

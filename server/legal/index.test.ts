import { describe, expect, expectTypeOf, it } from "vitest";
import * as area from "./index.ts";
import type { LegalService } from "./index.ts";

describe("server/legal public interface", () => {
  it("exports only the empty routes and schemas", () => {
    expect(Object.keys(area).sort()).toEqual(["LEGAL_ROUTES", "LEGAL_SCHEMAS"]);
    expect(area.LEGAL_ROUTES).toEqual([]);
    expect(area.LEGAL_SCHEMAS).toEqual({});
  });

  it("has a service type without members", () => {
    expectTypeOf<keyof LegalService>().toEqualTypeOf<string>();
    expectTypeOf<LegalService[string]>().toEqualTypeOf<never>();
  });
});

import { describe, expect, expectTypeOf, it } from "vitest";
import * as area from "./index.ts";
import type { RolesService } from "./index.ts";

describe("server/roles public interface", () => {
  it("exports only the empty routes and schemas", () => {
    expect(Object.keys(area).sort()).toEqual(["ROLES_ROUTES", "ROLES_SCHEMAS"]);
    expect(area.ROLES_ROUTES).toEqual([]);
    expect(area.ROLES_SCHEMAS).toEqual({});
  });

  it("has a service type without members", () => {
    expectTypeOf<keyof RolesService>().toEqualTypeOf<string>();
    expectTypeOf<RolesService[string]>().toEqualTypeOf<never>();
  });
});

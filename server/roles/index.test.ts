import { describe, expect, expectTypeOf, it } from "vitest";
import * as area from "./index.ts";
import type { RolesService } from "./index.ts";

describe("server/roles public interface", () => {
  it("exports the empty routes and schemas and the permissions table", () => {
    expect(Object.keys(area).sort()).toEqual([
      "ACCOUNT_KINDS",
      "ACTIONS",
      "CONTENT_ACTIONS",
      "CONTENT_SCOPES",
      "DELETION_ACTIONS",
      "LOGIN_ROWS",
      "OTHER_ACTIONS",
      "PERMISSION_ROWS",
      "ROLES_ROUTES",
      "ROLES_SCHEMAS",
      "SCOPES",
      "isAccountKind",
      "isAction",
      "loginOf",
      "scopeOf",
    ]);
    expect(area.ROLES_ROUTES).toEqual([]);
    expect(area.ROLES_SCHEMAS).toEqual({});
  });

  it("has a service type without members", () => {
    expectTypeOf<keyof RolesService>().toEqualTypeOf<string>();
    expectTypeOf<RolesService[string]>().toEqualTypeOf<never>();
  });
});

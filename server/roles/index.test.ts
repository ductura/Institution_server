import { describe, expect, expectTypeOf, it } from "vitest";
import { ADMIN_LOG_ACTIONS, LOG_ACCOUNT_KINDS, LOG_ACTIONS } from "../log/index.ts";
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
      "createSettingsService",
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

// server/log cannot import roles (docs/server-map.md §2), so its event catalog
// (S-1K.1) keeps copies; they must stay equal to the table here.
describe("server/log event catalog copies", () => {
  it("has the same account kinds and actions", () => {
    expect([...LOG_ACCOUNT_KINDS]).toEqual([...area.ACCOUNT_KINDS]);
    expect([...LOG_ACTIONS]).toEqual([...area.ACTIONS]);
  });

  it("lists exactly the actions a kind 3-5 account may take", () => {
    const admins = ["institution_admin", "app_admin", "network_engineer"] as const;
    const expected = area.ACTIONS.filter((action) =>
      admins.some((kind) => area.scopeOf(kind, action) !== "none"),
    );
    expect([...ADMIN_LOG_ACTIONS]).toEqual(expected);
  });
});

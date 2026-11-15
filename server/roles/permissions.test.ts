import { describe, expect, expectTypeOf, it } from "vitest";
import { ACCOUNT_KINDS, LOGIN_METHODS, isAccountKind } from "./account-kinds.ts";
import {
  ACTIONS,
  CONTENT_ACTIONS,
  CONTENT_SCOPES,
  DELETION_ACTIONS,
  PERMISSIONS,
  PERMISSION_ROWS,
  SCOPES,
  scopeOf,
} from "./permissions.ts";
import type { CellFor, ContentScope, KindCells, Scope } from "./permissions.ts";

describe("permissions table v2", () => {
  it("has one row per action, in order, and no duplicate", () => {
    expect(PERMISSION_ROWS.map(([action]) => action)).toEqual([...ACTIONS]);
    expect(new Set(ACTIONS).size).toBe(ACTIONS.length);
    expect([...PERMISSIONS.keys()]).toEqual([...ACTIONS]);
  });

  it("has exactly one valid value in every cell", () => {
    for (const [action, row] of PERMISSION_ROWS) {
      expect(row, action).toHaveLength(ACCOUNT_KINDS.length);
      for (const scope of row) expect(SCOPES).toContain(scope);
      expect([...(PERMISSIONS.get(action)?.keys() ?? [])]).toEqual([...ACCOUNT_KINDS]);
    }
  });

  it("does not let the type leave a cell empty or add one", () => {
    expectTypeOf<KindCells<"export_logs">["length"]>().toEqualTypeOf<5>();
    expectTypeOf<KindCells<"export_logs">[0]>().toEqualTypeOf<Scope>();
    expectTypeOf<undefined>().not.toExtend<KindCells<"export_logs">[4]>();
    expectTypeOf<readonly ["none", "none", "none", "none"]>().not.toExtend<
      KindCells<"export_logs">
    >();
  });

  it("gives work content only through own work or a relation (C-23)", () => {
    expectTypeOf<CellFor<"read_students_work">>().toEqualTypeOf<ContentScope>();
    expectTypeOf<"all">().not.toExtend<CellFor<"read_own_work">>();
    expectTypeOf<"own_institution">().not.toExtend<CellFor<"read_students_work">>();
    for (const action of CONTENT_ACTIONS) {
      for (const kind of ACCOUNT_KINDS) {
        expect(CONTENT_SCOPES).toContain(scopeOf(kind, action));
      }
      for (const kind of ["institution_admin", "app_admin", "network_engineer"] as const) {
        expect(scopeOf(kind, action), `${action} × ${kind}`).toBe("none");
      }
    }
    expect(scopeOf("student", "read_own_work")).toBe("own");
    expect(scopeOf("teacher", "read_students_work")).toBe("relation");
  });

  it("lists every action that reads work content as a content action", () => {
    const reads = ACTIONS.filter((action) => /^(read|view)_.*(work|content)/.test(action));
    expect(reads).toEqual([...CONTENT_ACTIONS]);
  });

  it("gives the app admin and the network engineer no deletion (D-299)", () => {
    for (const action of DELETION_ACTIONS) {
      expect(scopeOf("app_admin", action), action).toBe("none");
      expect(scopeOf("network_engineer", action), action).toBe("none");
    }
  });

  it("lists every deleting action as a deletion action", () => {
    const deleting = ACTIONS.filter((action) => /delet|erasure|archive|purge|remove/.test(action));
    expect(deleting).toEqual([...DELETION_ACTIONS]);
  });

  it("lets only the institution admin assign roles (D-297)", () => {
    for (const action of [
      "assign_student_teacher_roles",
      "assign_admin_network_engineer_roles",
    ] as const) {
      const granted = ACCOUNT_KINDS.filter((kind) => scopeOf(kind, action) !== "none");
      expect(granted).toEqual(["institution_admin"]);
    }
  });

  it("returns none for an unknown kind or action", () => {
    expect(scopeOf("operator", "export_logs")).toBe("none");
    expect(scopeOf("app_admin", "read_everything")).toBe("none");
    expect(scopeOf("app_admin", "constructor")).toBe("none");
    expect(scopeOf("__proto__", "export_logs")).toBe("none");
    expect(scopeOf(undefined, undefined)).toBe("none");
    expect(scopeOf("network_engineer", "export_logs")).toBe("all");
  });

  it("knows the five account kinds and their login", () => {
    expect(ACCOUNT_KINDS).toEqual([
      "student",
      "teacher",
      "institution_admin",
      "app_admin",
      "network_engineer",
    ]);
    expect(isAccountKind("operator")).toBe(false);
    expect([...LOGIN_METHODS.keys()]).toEqual([...ACCOUNT_KINDS]);
    expect(LOGIN_METHODS.get("student")).toEqual(["aai_eduhr"]);
    expect(LOGIN_METHODS.get("network_engineer")).toEqual(["aai_eduhr", "fido2"]);
    expect(LOGIN_METHODS.get("app_admin")).toBe("not_built");
  });
});

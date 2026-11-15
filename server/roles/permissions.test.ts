import { describe, expect, expectTypeOf, it } from "vitest";
import { ACCOUNT_KINDS, LOGIN_ROWS, isAccountKind, loginOf } from "./account-kinds.ts";
import {
  ACTIONS,
  CONTENT_ACTIONS,
  CONTENT_SCOPES,
  DELETION_ACTIONS,
  OTHER_ACTIONS,
  PERMISSION_ROWS,
  SCOPES,
  scopeOf,
} from "./permissions.ts";
import type { CellFor, ContentScope, KindCells, Scope } from "./permissions.ts";

/** Row of one action as kind → scope, read only through scopeOf. */
function rowOf(action: string): Record<string, string> {
  return Object.fromEntries(ACCOUNT_KINDS.map((kind) => [kind, scopeOf(kind, action)]));
}

describe("permissions table v2", () => {
  it("has every action with its class; a new action must change this list", () => {
    const classed = [
      ...CONTENT_ACTIONS.map((action) => `content ${action}`),
      ...OTHER_ACTIONS.map((action) => `other ${action}`),
      ...DELETION_ACTIONS.map((action) => `deletion ${action}`),
    ];
    expect(classed).toEqual([
      "content read_own_work",
      "content read_students_work",
      "other manage_courses_and_members",
      "other assign_student_teacher_roles",
      "other assign_admin_network_engineer_roles",
      "other change_personal_settings",
      "other change_course_settings",
      "other change_institution_settings",
      "other change_system_settings",
      "other change_network_security_settings",
      "other view_access_logs",
      "other view_system_metrics",
      "other manage_ip_rules",
      "other export_logs",
      "other backup_and_restore",
      "other edit_general_legal_texts",
      "other edit_institution_legal_addendum",
      "deletion delete_draft",
      "deletion request_submitted_work_deletion",
      "deletion approve_submitted_work_deletion",
      "deletion request_personal_data_erasure",
      "deletion execute_personal_data_erasure",
      "deletion archive_course",
    ]);
    expect(ACTIONS).toEqual([...CONTENT_ACTIONS, ...OTHER_ACTIONS, ...DELETION_ACTIONS]);
  });

  it("names actions and kinds only in lowercase ASCII with underscores", () => {
    for (const name of [...ACTIONS, ...ACCOUNT_KINDS, ...SCOPES]) {
      expect(name).toMatch(/^[a-z]+(?:_[a-z]+)*$/);
    }
  });

  it("cannot be changed at run time", () => {
    for (const list of [ACTIONS, ACCOUNT_KINDS, SCOPES, CONTENT_ACTIONS, DELETION_ACTIONS]) {
      expect(Object.isFrozen(list)).toBe(true);
    }
  });

  it("has one row per action, in order, and no duplicate", () => {
    expect(PERMISSION_ROWS.map(([action]) => action)).toEqual([...ACTIONS]);
    expect(new Set(ACTIONS).size).toBe(ACTIONS.length);
  });

  it("has exactly one valid value in every cell", () => {
    for (const [action, row] of PERMISSION_ROWS) {
      expect(row, action).toHaveLength(ACCOUNT_KINDS.length);
      for (const scope of row) expect(SCOPES).toContain(scope);
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
    const nobody = Object.fromEntries(ACCOUNT_KINDS.map((kind) => [kind, "none"]));
    expect(rowOf("read_own_work")).toEqual({ ...nobody, student: "own" });
    expect(rowOf("read_students_work")).toEqual({ ...nobody, teacher: "relation" });
  });

  it("has no other action whose name points at work content", () => {
    const suspicious = OTHER_ACTIONS.filter((action) =>
      /(?<!net)work|content|submission|draft|text(?!s)|paper|document|download/.test(action),
    );
    expect(suspicious).toEqual([]);
  });

  it("gives the app admin and the network engineer no deletion (D-299)", () => {
    for (const action of DELETION_ACTIONS) {
      expect(scopeOf("app_admin", action), action).toBe("none");
      expect(scopeOf("network_engineer", action), action).toBe("none");
    }
  });

  it("has no other action whose name points at deleting", () => {
    const deleting = OTHER_ACTIONS.filter((action) =>
      /delet|eras|archiv|purge|remov|wipe|destroy|drop|trash|discard|clear|anonymi/.test(action),
    );
    expect(deleting).toEqual([]);
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
    expect(LOGIN_ROWS.map(([kind]) => kind)).toEqual([...ACCOUNT_KINDS]);
    expect(ACCOUNT_KINDS.map((kind) => [kind, loginOf(kind)])).toEqual([
      ["student", ["aai_eduhr"]],
      ["teacher", ["aai_eduhr"]],
      ["institution_admin", ["aai_eduhr"]],
      ["app_admin", "not_built"],
      ["network_engineer", ["aai_eduhr", "fido2"]],
    ]);
    expect(loginOf("operator")).toBe("not_built");
  });
});

// Permissions table v2 as data (Ductus D-297, D-298, D-299, D-301, PRODUCT §3).
// docs/account-permissions.md holds the same table; a test compares the two in
// both directions, so a change to one without the other fails.
import { ACCOUNT_KINDS, isAccountKind } from "./account-kinds.ts";
import type { AccountKind } from "./account-kinds.ts";

/**
 * Scope of one cell. `none`: not allowed. `own`: only the account's own
 * things. `relation`: only through a relation (own course, mentorship; C-23).
 * `own_institution`, `own_institution_summary`: the account's institution, the
 * second as summarised logs only. `all`: every institution.
 */
export const SCOPES = [
  "none",
  "own",
  "relation",
  "own_institution",
  "own_institution_summary",
  "all",
] as const;

export type Scope = (typeof SCOPES)[number];

/** Scopes allowed on work content: access comes only from a relation (C-23). */
export const CONTENT_SCOPES = ["none", "own", "relation"] as const satisfies readonly Scope[];

export type ContentScope = (typeof CONTENT_SCOPES)[number];

/** Actions that reach the content of a student's work. */
export const CONTENT_ACTIONS = ["read_own_work", "read_students_work"] as const;

/** Actions that delete or archive works, courses or personal data (D-299). */
export const DELETION_ACTIONS = [
  "delete_draft",
  "request_submitted_work_deletion",
  "approve_submitted_work_deletion",
  "request_personal_data_erasure",
  "execute_personal_data_erasure",
  "archive_course",
] as const;

/** Every action, in the row order of docs/account-permissions.md. */
export const ACTIONS = [
  ...CONTENT_ACTIONS,
  "manage_courses_and_members",
  "assign_student_teacher_roles",
  "assign_admin_network_engineer_roles",
  "change_personal_settings",
  "change_course_settings",
  "change_institution_settings",
  "change_system_settings",
  "change_network_security_settings",
  "view_access_logs",
  "view_system_metrics",
  "manage_ip_rules",
  "export_logs",
  "backup_and_restore",
  ...DELETION_ACTIONS,
  "edit_general_legal_texts",
  "edit_institution_legal_addendum",
] as const;

export type Action = (typeof ACTIONS)[number];

export type ContentAction = (typeof CONTENT_ACTIONS)[number];

/** Cell type of an action: content actions take only a content scope. */
export type CellFor<A extends Action> = A extends ContentAction ? ContentScope : Scope;

type SameLength<T extends readonly unknown[], V> = { readonly [I in keyof T]: V };

/** One value per account kind, in the order of ACCOUNT_KINDS; no cell can be left out. */
export type KindCells<A extends Action> = SameLength<typeof ACCOUNT_KINDS, CellFor<A>>;

/** One row of the table: an action and its five cells. */
export type PermissionRow = { [A in Action]: readonly [A, KindCells<A>] }[Action];

/**
 * Permissions table v2, one row per action in the order of ACTIONS. Columns:
 * student, teacher, institution_admin, app_admin, network_engineer. Sources
 * per row are in docs/account-permissions.md.
 */
export const PERMISSION_ROWS = [
  ["read_own_work", ["own", "none", "none", "none", "none"]],
  ["read_students_work", ["none", "relation", "none", "none", "none"]],
  ["manage_courses_and_members", ["none", "relation", "own_institution", "all", "none"]],
  ["assign_student_teacher_roles", ["none", "none", "own_institution", "none", "none"]],
  ["assign_admin_network_engineer_roles", ["none", "none", "own_institution", "none", "none"]],
  ["change_personal_settings", ["own", "own", "own", "own", "own"]],
  ["change_course_settings", ["none", "relation", "own_institution", "none", "none"]],
  ["change_institution_settings", ["none", "none", "own_institution", "none", "none"]],
  ["change_system_settings", ["none", "none", "none", "all", "none"]],
  ["change_network_security_settings", ["none", "none", "none", "all", "all"]],
  ["view_access_logs", ["none", "none", "own_institution_summary", "all", "all"]],
  ["view_system_metrics", ["none", "none", "none", "all", "all"]],
  ["manage_ip_rules", ["none", "none", "none", "all", "all"]],
  ["export_logs", ["none", "none", "none", "all", "all"]],
  ["backup_and_restore", ["none", "none", "none", "all", "all"]],
  ["delete_draft", ["own", "none", "none", "none", "none"]],
  ["request_submitted_work_deletion", ["own", "none", "none", "none", "none"]],
  ["approve_submitted_work_deletion", ["none", "none", "own_institution", "none", "none"]],
  ["request_personal_data_erasure", ["own", "none", "none", "none", "none"]],
  ["execute_personal_data_erasure", ["none", "none", "own_institution", "none", "none"]],
  ["archive_course", ["none", "none", "own_institution", "none", "none"]],
  ["edit_general_legal_texts", ["none", "none", "none", "all", "none"]],
  ["edit_institution_legal_addendum", ["none", "none", "own_institution", "none", "none"]],
] as const satisfies readonly PermissionRow[];

type AssertTrue<T extends true> = T;

/** Fails to compile when an action has no row. */
export type EveryActionHasARow = AssertTrue<
  [Exclude<Action, (typeof PERMISSION_ROWS)[number][0]>] extends [never] ? true : false
>;

/** Lookup built from PERMISSION_ROWS: action → kind → scope. */
export const PERMISSIONS: ReadonlyMap<Action, ReadonlyMap<AccountKind, Scope>> = new Map(
  PERMISSION_ROWS.map(([action, row]) => [
    action,
    new Map(ACCOUNT_KINDS.map((kind, index) => [kind, row[index] ?? "none"])),
  ]),
);

/** True for a value that is one of the actions. */
export function isAction(value: unknown): value is Action {
  return typeof value === "string" && (ACTIONS as readonly string[]).includes(value);
}

/**
 * Scope of `kind` for `action`; `none` for an unknown kind or action, so a
 * typo never grants anything. A scope other than `none` is only the upper
 * bound: the caller still checks the relation or institution of the target.
 */
export function scopeOf(kind: unknown, action: unknown): Scope {
  if (!isAccountKind(kind) || !isAction(action)) return "none";
  return PERMISSIONS.get(action)?.get(kind) ?? "none";
}

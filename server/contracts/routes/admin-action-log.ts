import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

// SRV-ADMIN-1 (NF-7 OA-3; owner decision 23. 11. 2026., item 4): the log of
// what administrators and operators did in the caller's institution, for a
// confirmed administrator, read only (app.admin_action_log, migration
// 20261215100100). A row says when, in which role, what kind of action, about
// which role (for a role action) and the outcome; it never names a person, a
// student, a work, a case or a request. The rows come from records that are
// only ever appended, so an entry is never changed or removed.

/** The most entries one answer carries, newest first; `truncated` says more exist. */
export const ADMIN_ACTIONS_PAGE = 500;

export const ADMIN_ACTION_KINDS = [
  "role_confirmed",
  "role_revoked",
  "rule_published",
  "threshold_changed",
  "hold_placed",
  "hold_released",
  "export_requested",
  "export_approved",
] as const;

export const ADMIN_ACTOR_ROLES = ["institution_admin", "registry_clerk", "operator"] as const;

export const ADMIN_SUBJECT_ROLES = [
  "teacher",
  "institution_admin",
  "network_engineer",
  "registry_clerk",
] as const;

const literals = <T extends string>(values: readonly T[]) =>
  Type.Union(values.map((value) => Type.Literal(value)));

/** Date.toISOString of a finite instant. */
const Instant = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$" });

export const AdminActionEntry = closed({
  at: Instant,
  actorRole: literals(ADMIN_ACTOR_ROLES),
  action: literals(ADMIN_ACTION_KINDS),
  /** The role a role action is about; null for any other action. */
  subjectRole: Type.Union([literals(ADMIN_SUBJECT_ROLES), Type.Null()]),
  /** Only actions that took effect are recorded; a refused attempt leaves no row. */
  outcome: Type.Literal("completed"),
});

export const adminActionsGet = defineRoute({
  id: "institution.admin-actions.get",
  method: "GET",
  path: "/api/v1/institution/admin-actions",
  inventory: "app/api/institution/admin-actions/route.ts",
  access: "institution_admin",
  summary:
    "The log of administrator and operator actions in the caller's institution, newest first, at most 500 (truncated says more exist): roles confirmed or revoked, rules published, thresholds changed, legal holds placed or released, data exports requested or approved. Each entry has the time, the acting role, the kind of action, the role it concerns and the outcome, and no person, student, work or case. Read only; a caller who is not a confirmed administrator is 403.",
  request: { query: Type.Object({}, { maxProperties: 0 }) },
  responses: [
    {
      status: 200,
      description: "the log, possibly empty",
      body: closed({
        entries: Type.Array(AdminActionEntry, { maxItems: ADMIN_ACTIONS_PAGE }),
        truncated: Type.Boolean(),
      }),
      headers: ["cache-control"],
    },
  ],
  errors: [
    error(401, "unauthorized"),
    error(403, "forbidden"),
    error(422, "invalid_input"),
    error(503, "unavailable"),
  ],
});

export const adminActionLogRoutes = [adminActionsGet] as const;

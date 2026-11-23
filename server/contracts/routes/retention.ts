import { Type, type Static } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

// SRV-1304 (plan M10.2, M10.7): the dry run of the data classes for the
// institution's administrator. The classes and their order are those of
// server/domain/retention/catalog.ts; the label is a message key.
const Count = Type.Integer({ minimum: 0, maximum: 2_147_483_647 });

export const RETENTION_PERIOD_STATUSES = ["decided", "awaiting_decision", "never_deleted"] as const;
const RetentionPeriodStatus = Type.Union(
  RETENTION_PERIOD_STATUSES.map((status) => Type.Literal(status)),
  {
    description:
      "decided: retentionDays is a number; awaiting_decision: retentionDays is null because nobody has decided the period yet (none is ever made up); never_deleted: the class proves a submission and is never deleted.",
  },
);

export const RetentionClassReport = closed({
  key: Type.Union([
    Type.Literal("sessions"),
    Type.Literal("live-state"),
    Type.Literal("versions"),
    Type.Literal("change-times"),
    Type.Literal("access-log"),
    Type.Literal("receipts"),
  ]),
  label: Type.String({ pattern: "^retention\\.[a-zA-Z]+$", maxLength: 64 }),
  retentionDays: Type.Union([Type.Integer({ minimum: 1, maximum: 36_500 }), Type.Null()]),
  mode: Type.Union([Type.Literal("execute"), Type.Literal("dry-run")]),
  candidates: Type.Union([Count, Type.Null()]),
  lastRunAt: Type.Union([Type.String({ format: "date-time", maxLength: 24 }), Type.Null()]),
  // SRV-ADMIN-3 (owner decision of 23. 11. 2026., item 5): why a period is what
  // it is. decided: retentionDays is a number; awaiting_decision: retentionDays
  // is null because nobody has decided it yet (never a made-up period);
  // never_deleted: the class proves a submission and is never deleted.
  // periodStatusKey is the text of the server's catalogue (locales,
  // adminSettings.retentionPeriod). Optional in v1: new response fields.
  periodStatus: Type.Optional(RetentionPeriodStatus),
  periodStatusKey: Type.Optional(
    Type.Union([
      Type.Literal("adminSettings.retentionPeriod.decided"),
      Type.Literal("adminSettings.retentionPeriod.awaitingDecision"),
      Type.Literal("adminSettings.retentionPeriod.neverDeleted"),
    ]),
  ),
});

export const RetentionReport = closed({
  classes: Type.Array(RetentionClassReport, { maxItems: 32 }),
});
export type RetentionReport = Static<typeof RetentionReport>;

export const retentionGet = defineRoute({
  id: "institution.retention.get",
  method: "GET",
  path: "/api/v1/institution/retention",
  inventory: "app/api/institution/retention/route.ts",
  access: "institution_admin",
  summary:
    "The dry run of retention for an administrator of the institution of the session: per data class (sessions, live view state, versions, time per change, access log, hashes and receipts) its message key, its period in days or null while undecided (D-30), its mode, how many rows a deletion would take and the time of the last deletion run. A class with a null period is always dry-run. Hashes and receipts are never deleted and never counted (candidates null); a class without storage of its own has null candidates. Nothing is deleted or written. A teacher, a student or an administrator of another institution is 403. No query.",
  request: { query: Type.Object({}, { maxProperties: 0 }) },
  responses: [{ status: 200, description: "the data classes", body: RetentionReport }],
  errors: [
    error(401, "unauthorized"),
    error(403, "forbidden"),
    error(422, "invalid_input"),
    error(503, "unavailable"),
  ],
});

import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

import { MUTATION_GUARD } from "./shared.ts";

// Literal port of Ductus 078c780: app/api/support/problem-report/route.ts,
// src/server/support/problem-report-route.ts and the classes of
// src/domain/support/problem-report.ts (DAN-431). No field can hold the text of
// a work; identity and institution come from the session, never the body.

const literals = <T extends string>(values: readonly T[]) =>
  Type.Union(values.map((value) => Type.Literal(value)));

/**
 * A page as its route template (PROBLEM_REPORT_ROUTES): lowercase segments and
 * [name] for an id, never a path with ids, a query or a hash. The schema keeps
 * the form; the server checks the closed list of 27 templates (422). The list
 * is not written here: one of its slugs reads as a sentence to the
 * hard-coded-text lint (DAN-784), and the contract holds no page names.
 */
const PAGE_ROUTE = Type.String({
  maxLength: 128,
  pattern:
    "^/(?:(?:[a-z]+(?:-[a-z]+)*|\\[[A-Za-z]+\\])(?:/(?:[a-z]+(?:-[a-z]+)*|\\[[A-Za-z]+\\]))*)?$",
});

/** src/domain/sync/states.ts SYNC_STATES. */
const SYNC_STATES = [
  ...["EDITING", "SAVING_LOCAL", "LOCAL_DURABLE", "SYNCING", "SYNCED", "CONFLICT", "ERROR"],
  "RECOVERY_REQUIRED",
] as const;

/** A release (1.2.3, optionally +commit) or a bare commit: digits and hex only. */
const APP_VERSION =
  "^(?:(?:0|[1-9][0-9]{0,3})\\.(?:0|[1-9][0-9]{0,3})\\.(?:0|[1-9][0-9]{0,3})(?:\\+[0-9a-f]{7,40})?|[0-9a-f]{7,40})$";

export const problemReportPost = defineRoute({
  id: "support.problem-report.post",
  method: "POST",
  path: "/api/v1/support/problem-report",
  inventory: "app/api/support/problem-report/route.ts",
  access: "signed_in",
  summary:
    "Sends a problem report: the user's description and a closed technical context. The body is the JCS form of the value, at most 8 KiB; the description is 1 to 1000 code points with a visible character and no control or bidi character other than newline and tab (checked by the server, answered 422). At most five reports per account in an hour.",
  request: {
    contentType: "application/json",
    maxBodyBytes: 8 * 1024,
    body: closed({
      appVersion: Type.String({ pattern: APP_VERSION }),
      browser: closed({
        family: literals(["chromium", "firefox", "safari", "other"]),
        major: Type.Union([Type.Integer({ minimum: 0, maximum: 999 }), Type.Null()]),
      }),
      category: literals(["technical", "account", "course"]),
      // 1000 code points are at most 2000 UTF-16 units; the server counts code points.
      description: Type.String({ minLength: 1, maxLength: 2000 }),
      route: Type.Union([PAGE_ROUTE, Type.Null()]),
      syncState: Type.Union([literals(SYNC_STATES), Type.Null()]),
    }),
  },
  responses: [
    {
      status: 201,
      description: "recorded; the reference the user quotes",
      body: closed({ reference: Type.String({ pattern: "^PR-[0-9A-F]{10}$" }) }),
    },
  ],
  errors: [
    ...MUTATION_GUARD,
    error(401, "unauthorized"),
    error(415, "unsupported_media_type"),
    error(400, "invalid_json"),
    error(422, "invalid_input"),
    error(429, "too_many_reports"),
    error(503, "unavailable"),
  ],
});

export const supportRoutes = [problemReportPost] as const;

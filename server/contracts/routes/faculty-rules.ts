import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

import { MUTATION_GUARD } from "./shared.ts";

// SRV-2001 (Ductus#2052; phase 3 web-server alignment): the HTTP layer over
// server/institution/faculty-rules.ts (DAN-590, DAN-315). A confirmed
// administrator of the institution reads the published versions of the
// faculty rules per work type and publishes the next one. A version is only
// added and never changes. The institution and the author come only from the
// session. An account that is not a confirmed administrator is 403.

const WorkType = Type.Union([
  Type.Literal("short_paper"),
  Type.Literal("essay"),
  Type.Literal("seminar_paper"),
  Type.Literal("bachelor_thesis"),
  Type.Literal("master_thesis"),
  Type.Literal("specialist_thesis"),
  Type.Literal("doctoral_thesis"),
]);
const AiPolicy = Type.Union([
  Type.Literal("prohibited"),
  Type.Literal("partially_allowed"),
  Type.Literal("encouraged"),
]);
const AiPurpose = Type.Union([
  Type.Literal("formatting"),
  Type.Literal("proofreading"),
  Type.Literal("literature_search"),
  Type.Literal("transcription"),
  Type.Literal("translation"),
]);
const EvidenceProfile = Type.Union([Type.Literal("basic"), Type.Literal("extended")]);
const VersionNo = Type.Integer({ minimum: 1, maximum: 2_147_483_647 });
const Instant = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$" });

/** One published version: its number, content, origin and the moment it was published. */
const FacultyRuleVersion = closed({
  versionNo: VersionNo,
  aiPolicy: AiPolicy,
  aiPurposes: Type.Array(AiPurpose, { maxItems: 5 }),
  evidenceProfile: EvidenceProfile,
  importAllowed: Type.Boolean(),
  origin: Type.Union([Type.Literal("operator"), Type.Literal("administrator")]),
  publishedAt: Instant,
});

export const facultyRulesGet = defineRoute({
  id: "institution.faculty-rules.get",
  method: "GET",
  path: "/api/v1/institution/faculty-rules",
  inventory: "app/api/institution/faculty-rules/route.ts",
  access: "institution_admin",
  summary:
    "The faculty rules of the caller's institution for an administrator of it: one entry per work type, in the fixed order of work types, each with its published versions in ascending order of versionNo (an empty list when none is published). No query: any query parameter is 422. A teacher, a student and an account without a confirmed administrator role are 403.",
  request: { query: Type.Object({}, { maxProperties: 0 }) },
  responses: [
    {
      status: 200,
      description: "the rule versions per work type",
      body: closed({
        rules: Type.Array(
          closed({
            workType: WorkType,
            versions: Type.Array(FacultyRuleVersion, { maxItems: 500 }),
          }),
          { maxItems: 7 },
        ),
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

export const facultyRulesPost = defineRoute({
  id: "institution.faculty-rules.post",
  method: "POST",
  path: "/api/v1/institution/faculty-rules",
  inventory: "app/api/institution/faculty-rules/route.ts",
  access: "institution_admin",
  summary:
    "An administrator of the institution publishes the next version of the rules of one work type: exactly {workType, basedOnVersionNo, aiPolicy, aiPurposes, evidenceProfile, importAllowed}, at most 4 KiB, sent as application/json. basedOnVersionNo is the latest version the administrator saw, or null when none is published; another version published in between is 409 conflict. Purposes are a set of at most five and none with the policy prohibited; a value outside the closed lists or a purpose with the prohibited policy is 422 (invalid_work_type, invalid_ai_policy, invalid_ai_purposes, invalid_evidence_profile, or invalid_input for any other shape). A teacher, a student and an account without a confirmed administrator role are 403. The institution, the author and the time come from the session and the database clock, never from the body. The version is recorded in the audit trail in the same transaction. Success follows the database commit.",
  request: {
    contentType: "application/json",
    maxBodyBytes: 4096,
    body: closed({
      workType: WorkType,
      basedOnVersionNo: Type.Union([VersionNo, Type.Null()]),
      aiPolicy: AiPolicy,
      aiPurposes: Type.Array(AiPurpose, { maxItems: 5 }),
      evidenceProfile: EvidenceProfile,
      importAllowed: Type.Boolean(),
    }),
  },
  responses: [
    {
      status: 201,
      description: "the new version is published",
      body: closed({ versionNo: VersionNo, publishedAt: Instant }),
      headers: ["cache-control"],
    },
  ],
  errors: [
    ...MUTATION_GUARD,
    error(401, "unauthorized"),
    error(415, "unsupported_media_type"),
    error(400, "invalid_json"),
    error(403, "forbidden"),
    error(422, "invalid_input"),
    error(422, "invalid_work_type"),
    error(422, "invalid_ai_policy"),
    error(422, "invalid_ai_purposes"),
    error(422, "invalid_evidence_profile"),
    error(409, "conflict"),
    error(503, "unavailable"),
  ],
});

export const facultyRulesRoutes = [facultyRulesGet, facultyRulesPost] as const;

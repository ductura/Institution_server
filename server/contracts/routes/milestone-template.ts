import { Type, type Static } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

import { MUTATION_GUARD } from "./shared.ts";
import { CODE_POINT, END } from "./teacher.ts";
import { WorkMilestoneId } from "./work-milestones.ts";

// SRV-1521 (Ductus#2052, N-15 etape): the template of milestones of an institution and the
// plan of milestones of one mentored work. The template is versioned like the rules of the
// institution (institution.config.*): only an administrator reads it or adds a version, a
// version is only ever added. A new mentorship assignment gets the latest version when it
// is made; from then on the mentor changes the milestones of that work alone.

const DocumentId = Type.String({
  pattern: `^(?!\\s)(?:${CODE_POINT}|[^\\u0000-\\u001f\\u007f-\\u009f\\uD800-\\uDFFF]){1,256}(?<!\\s)${END}`,
});
const Instant = Type.String({
  pattern: `^\\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])T(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d{1,3})?(?:Z|[+-](?:[01]\\d|2[0-3]):[0-5]\\d)${END}`,
});

/** What a milestone sends: the topic text of the work or the version of the work at that moment. */
export const MilestoneSubmits = Type.Union([
  Type.Literal("topic_text"),
  Type.Literal("current_version"),
]);

/** The most milestones of one template. */
export const MILESTONE_TEMPLATE_MAX_ITEMS = 20;
/** The longest relative deadline of a template milestone, in days after the work is made. */
export const MILESTONE_TEMPLATE_MAX_DAYS = 1095;

const Title = Type.String({ minLength: 1, maxLength: 200 });

/** One milestone of a template: relativeDue is a whole number of days after the work is made. */
export const MilestoneTemplateItem = closed({
  title: Title,
  relativeDue: Type.Optional(Type.Integer({ minimum: 1, maximum: MILESTONE_TEMPLATE_MAX_DAYS })),
  submits: MilestoneSubmits,
});
export type MilestoneTemplateItem = Static<typeof MilestoneTemplateItem>;

export const MilestoneTemplateVersion = closed({
  version: Type.Integer({ minimum: 1, maximum: 2_147_483_647 }),
  effectiveFrom: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$" }),
  requireFinalStageApproval: Type.Boolean(),
  milestones: Type.Array(MilestoneTemplateItem, { maxItems: MILESTONE_TEMPLATE_MAX_ITEMS }),
});
export type MilestoneTemplateVersion = Static<typeof MilestoneTemplateVersion>;

export const MilestoneTemplateInput = closed({
  /** The latest version the administrator saw; 0 when there was none. */
  expectedVersion: Type.Integer({ minimum: 0, maximum: 2_147_483_646 }),
  requireFinalStageApproval: Type.Boolean(),
  milestones: Type.Array(MilestoneTemplateItem, { maxItems: MILESTONE_TEMPLATE_MAX_ITEMS }),
});
export type MilestoneTemplateInput = Static<typeof MilestoneTemplateInput>;

const PlanItem = closed({
  id: WorkMilestoneId,
  position: Type.Integer({ minimum: 1, maximum: 100 }),
  title: Title,
  dueAt: Type.Union([Instant, Type.Null()]),
  submits: MilestoneSubmits,
});
const Plan = closed({ milestones: Type.Array(PlanItem, { maxItems: 100 }) });

export const WorkMilestoneAddInput = closed({
  title: Title,
  dueAt: Type.Optional(Instant),
  submits: MilestoneSubmits,
});
export type WorkMilestoneAddInput = Static<typeof WorkMilestoneAddInput>;

export const milestoneTemplateGet = defineRoute({
  id: "institution.milestone-template.get",
  method: "GET",
  path: "/api/v1/institution/milestone-template",
  inventory: "app/api/institution/milestone-template/route.ts",
  access: "institution_admin",
  summary:
    "The template of milestones of the caller's institution for an administrator of it: current is the latest version, or null while there is none, and versions is the whole history in ascending order. Each version is {version, effectiveFrom, requireFinalStageApproval, milestones}, a milestone being {title, relativeDue?, submits}. No query. A teacher, a student and an account without a confirmed role are 403.",
  request: { query: Type.Object({}, { maxProperties: 0 }) },
  responses: [
    {
      status: 200,
      description: "the current version and the history",
      body: closed({
        current: Type.Union([MilestoneTemplateVersion, Type.Null()]),
        versions: Type.Array(MilestoneTemplateVersion),
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

export const milestoneTemplatePut = defineRoute({
  id: "institution.milestone-template.put",
  method: "PUT",
  path: "/api/v1/institution/milestone-template",
  inventory: "app/api/institution/milestone-template/route.ts",
  access: "institution_admin",
  summary:
    "An administrator of the institution replaces its template of milestones with a new version: exactly {expectedVersion, requireFinalStageApproval, milestones}, at most 16 KiB, sent as application/json. expectedVersion is the latest version the administrator saw (0 when none); another version added in between is 409 conflict. At most 20 milestones, each {title, relativeDue?, submits}: a title of 1 to 200 characters, relativeDue a whole number of days from 1 to 1095 after a work is made, submits topic_text or current_version; anything else is 422 invalid_input. requireFinalStageApproval says whether the final submission waits for the approval of the last milestone; false is the default and the final submission is independent of it. Works that already have their milestones keep them. A teacher, a student and an account without a confirmed role are 403. The institution and the author come from the session, never from the body.",
  request: {
    contentType: "application/json",
    maxBodyBytes: 16384,
    body: MilestoneTemplateInput,
  },
  responses: [
    {
      status: 200,
      description: "the new version",
      body: MilestoneTemplateVersion,
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
    error(409, "conflict"),
    error(503, "unavailable"),
  ],
});

const params = closed({ documentId: DocumentId });
const readErrors = [error(401, "unauthorized"), error(404, "not_found"), error(503, "unavailable")];
const writeErrors = [
  ...MUTATION_GUARD,
  ...readErrors,
  error(403, "forbidden"),
  error(409, "conflict"),
  error(415, "unsupported_media_type"),
  error(400, "invalid_json"),
  error(422, "invalid_input"),
];

export const workMilestonePlanGet = defineRoute({
  id: "work.milestone-plan.get",
  method: "GET",
  path: "/api/v1/works/{documentId}/milestone-plan",
  inventory: "app/api/works/[documentId]/milestone-plan/route.ts",
  access: "owner_or_course_teacher",
  summary:
    "The milestones of one work as they are configured, in workflow order, with what each sends (submits) and the deadline of this work, for its owner and teachers. The student sees what the mentor sees. The state of each milestone is work.milestone-states.get.",
  request: { params },
  responses: [{ status: 200, description: "The plan of the work", body: Plan }],
  errors: readErrors,
});

export const workMilestonePlanAdd = defineRoute({
  id: "work.milestone-plan.add.post",
  method: "POST",
  path: "/api/v1/works/{documentId}/milestone-plan/milestones",
  inventory: "app/api/works/[documentId]/milestone-plan/milestones/route.ts",
  access: "mentor_teacher",
  summary:
    "The mentor of a work adds a milestone at the end of its plan: {title, dueAt?, submits}, at most 2 KiB. The answer is the whole plan. Not after the final submission of the work (409), at most 100 milestones (409). A student and a teacher who is not the mentor of the work are 403.",
  request: {
    params,
    contentType: "application/json",
    body: WorkMilestoneAddInput,
    maxBodyBytes: 2048,
  },
  responses: [
    { status: 201, description: "The plan of the work with the new milestone", body: Plan },
  ],
  errors: writeErrors,
});

export const workMilestonePlanApplyTemplate = defineRoute({
  id: "work.milestone-plan.apply-template.post",
  method: "POST",
  path: "/api/v1/works/{documentId}/milestone-plan/apply-template",
  inventory: "app/api/works/[documentId]/milestone-plan/apply-template/route.ts",
  access: "mentor_teacher",
  summary:
    "The mentor of a work replaces its milestones with the latest template of the institution. No body. Refused (409) once any milestone of the work was ever submitted, after the final submission, and while the institution has no template. A student and a teacher who is not the mentor of the work are 403. The answer is the whole plan.",
  request: { params, maxBodyBytes: 0 },
  responses: [{ status: 200, description: "The plan of the work from the template", body: Plan }],
  errors: [...MUTATION_GUARD, ...readErrors, error(403, "forbidden"), error(409, "conflict")],
});

export const milestoneTemplateRoutes = [
  milestoneTemplateGet,
  milestoneTemplatePut,
  workMilestonePlanGet,
  workMilestonePlanAdd,
  workMilestonePlanApplyTemplate,
] as const;

import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

import { MUTATION_GUARD } from "./shared.ts";
import { CODE_POINT, END } from "./teacher.ts";

const DocumentId = Type.String({
  pattern: `^(?!\\s)(?:${CODE_POINT}|[^\\u0000-\\u001f\\u007f-\\u009f\\uD800-\\uDFFF]){1,256}(?<!\\s)${END}`,
});
export const WorkMilestoneId = Type.String({
  pattern: `^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}${END}`,
});
const Instant = Type.String({
  pattern: `^\\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])T(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d{1,3})?(?:Z|[+-](?:[01]\\d|2[0-3]):[0-5]\\d)${END}`,
});
const WorkMilestone = closed({
  id: WorkMilestoneId,
  title: Type.String({ minLength: 1, maxLength: 200 }),
  description: Type.String({ maxLength: 2000 }),
  dueAt: Type.Union([Instant, Type.Null()]),
  state: Type.Union([
    Type.Literal("open"),
    Type.Literal("submitted"),
    Type.Literal("approved"),
    Type.Literal("returned"),
  ]),
});
export const WorkMilestoneDueInput = closed({ dueAt: Instant });

const Revision = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const WorkMilestoneState = closed({
  id: WorkMilestoneId,
  title: Type.String({ minLength: 1, maxLength: 200 }),
  description: Type.String({ maxLength: 2000 }),
  dueAt: Type.Union([Instant, Type.Null()]),
  state: Type.Union([
    Type.Literal("not_submitted"),
    Type.Literal("submitted"),
    Type.Literal("revision_requested"),
    Type.Literal("approved"),
  ]),
  everSubmitted: Type.Boolean(),
  submittedRevisionId: Type.Union([Revision, Type.Null()]),
  submittedAt: Type.Union([Instant, Type.Null()]),
  revisionComment: Type.Union([Type.String({ minLength: 1, maxLength: 2000 }), Type.Null()]),
  revisionDueAt: Type.Union([Instant, Type.Null()]),
  revisionRequestedAt: Type.Union([Instant, Type.Null()]),
  approvedAt: Type.Union([Instant, Type.Null()]),
  approvalMessage: Type.Union([Type.String({ minLength: 1, maxLength: 1000 }), Type.Null()]),
});
export const WorkMilestoneChangeInput = closed({
  dueAt: Type.Optional(Instant),
  title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
});
export const WorkMilestoneRevisionInput = closed({
  comment: Type.String({ minLength: 1, maxLength: 2000 }),
  revisionDueAt: Type.Optional(Instant),
});
export const WorkMilestoneApprovalInput = closed({
  message: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
});

const readErrors = [error(401, "unauthorized"), error(404, "not_found"), error(503, "unavailable")];

export const workMilestonesGet = defineRoute({
  id: "work.milestones.get",
  method: "GET",
  path: "/api/v1/works/{documentId}/milestones",
  inventory: "app/api/works/[documentId]/milestones/route.ts",
  access: "owner_or_course_teacher",
  summary: "The configured milestones of one work, in workflow order, for its owner and teachers.",
  request: { params: closed({ documentId: DocumentId }) },
  responses: [
    {
      status: 200,
      description: "Configured milestones with the current deadlines of this work",
      body: closed({ milestones: Type.Array(WorkMilestone, { maxItems: 100 }) }),
    },
  ],
  errors: readErrors,
});

export const workMilestonePatch = defineRoute({
  id: "work.milestones.patch",
  method: "PATCH",
  path: "/api/v1/works/{documentId}/milestones/{milestoneId}",
  inventory: "app/api/works/[documentId]/milestones/[milestoneId]/route.ts",
  access: "course_teacher",
  summary: "A teacher changes the deadline of one configured milestone of an unsubmitted work.",
  request: {
    params: closed({ documentId: DocumentId, milestoneId: WorkMilestoneId }),
    contentType: "application/json",
    body: WorkMilestoneDueInput,
    maxBodyBytes: 256,
  },
  responses: [{ status: 200, description: "Updated milestone", body: WorkMilestone }],
  errors: [
    ...MUTATION_GUARD,
    ...readErrors,
    error(400, "invalid_json"),
    error(403, "forbidden"),
    error(409, "conflict"),
    error(415, "unsupported_media_type"),
    error(422, "invalid_input"),
  ],
});

const params = closed({ documentId: DocumentId, milestoneId: WorkMilestoneId });
const transitionErrors = [
  ...MUTATION_GUARD,
  ...readErrors,
  error(400, "invalid_json"),
  error(403, "forbidden"),
  error(409, "conflict"),
  error(415, "unsupported_media_type"),
  error(422, "invalid_input"),
];

export const workMilestoneStatesGet = defineRoute({
  id: "work.milestone-states.get",
  method: "GET",
  path: "/api/v1/works/{documentId}/milestone-states",
  inventory: "app/api/works/[documentId]/milestone-states/route.ts",
  access: "owner_or_course_teacher",
  summary:
    "The milestones of one work in workflow order with the state of each (not_submitted, submitted, revision_requested, approved), for its owner and teachers. The student sees what the mentor sees.",
  request: { params: closed({ documentId: DocumentId }) },
  responses: [
    {
      status: 200,
      description: "Milestones with the current deadlines and states of this work",
      body: closed({ milestones: Type.Array(WorkMilestoneState, { maxItems: 100 }) }),
    },
  ],
  errors: readErrors,
});

export const workMilestoneDetailsPatch = defineRoute({
  id: "work.milestones.details.patch",
  method: "PATCH",
  path: "/api/v1/works/{documentId}/milestones/{milestoneId}/details",
  inventory: "app/api/works/[documentId]/milestones/[milestoneId]/details/route.ts",
  access: "course_teacher",
  summary:
    "A teacher changes the title and/or the deadline of one milestone, also after it was sent. The deadline does not change after the final submission (409); a title changes only on the assignment of a mentorship (409 elsewhere).",
  request: {
    params,
    contentType: "application/json",
    body: WorkMilestoneChangeInput,
    maxBodyBytes: 1024,
  },
  responses: [{ status: 200, description: "The changed milestone", body: WorkMilestoneState }],
  errors: transitionErrors,
});

export const workMilestoneSubmitPost = defineRoute({
  id: "work.milestones.submit.post",
  method: "POST",
  path: "/api/v1/works/{documentId}/milestones/{milestoneId}/submit",
  inventory: "app/api/works/[documentId]/milestones/[milestoneId]/submit/route.ts",
  access: "student_owner",
  summary:
    "The student owner sends a milestone for review. The revision of the work at this moment is frozen as a reference (submittedRevisionId); no content is copied. Only from not_submitted or revision_requested; the milestone deadline is a reminder and never blocks.",
  request: { params, maxBodyBytes: 0 },
  responses: [
    { status: 200, description: "The milestone, now submitted", body: WorkMilestoneState },
  ],
  errors: [...MUTATION_GUARD, ...readErrors, error(403, "forbidden"), error(409, "conflict")],
});

export const workMilestoneRequestRevisionPost = defineRoute({
  id: "work.milestones.request-revision.post",
  method: "POST",
  path: "/api/v1/works/{documentId}/milestones/{milestoneId}/request-revision",
  inventory: "app/api/works/[documentId]/milestones/[milestoneId]/request-revision/route.ts",
  access: "mentor_teacher",
  summary:
    "The mentor of the work asks for a revision of a submitted milestone. The comment is required; revisionDueAt is a reminder and never blocks writing or submitting.",
  request: {
    params,
    contentType: "application/json",
    body: WorkMilestoneRevisionInput,
    maxBodyBytes: 8192,
  },
  responses: [
    { status: 200, description: "The milestone, now revision_requested", body: WorkMilestoneState },
  ],
  errors: transitionErrors,
});

export const workMilestoneApprovePost = defineRoute({
  id: "work.milestones.approve.post",
  method: "POST",
  path: "/api/v1/works/{documentId}/milestones/{milestoneId}/approve",
  inventory: "app/api/works/[documentId]/milestones/[milestoneId]/approve/route.ts",
  access: "mentor_teacher",
  summary: "The mentor of the work approves a submitted milestone, with an optional short message.",
  request: {
    params,
    contentType: "application/json",
    body: WorkMilestoneApprovalInput,
    maxBodyBytes: 4096,
  },
  responses: [
    { status: 200, description: "The milestone, now approved", body: WorkMilestoneState },
  ],
  errors: transitionErrors,
});

export const workMilestoneDelete = defineRoute({
  id: "work.milestones.delete",
  method: "DELETE",
  path: "/api/v1/works/{documentId}/milestones/{milestoneId}",
  inventory: "app/api/works/[documentId]/milestones/[milestoneId]/route.ts",
  access: "mentor_teacher",
  summary:
    "The mentor deletes a milestone that was never submitted. A milestone that was ever submitted answers 409: it can only be renamed.",
  request: { params, maxBodyBytes: 0 },
  responses: [{ status: 204, description: "The milestone is deleted" }],
  errors: [...MUTATION_GUARD, ...readErrors, error(403, "forbidden"), error(409, "conflict")],
});

export const workMilestonesRoutes = [
  workMilestonesGet,
  workMilestonePatch,
  workMilestoneDelete,
  workMilestoneStatesGet,
  workMilestoneDetailsPatch,
  workMilestoneSubmitPost,
  workMilestoneRequestRevisionPost,
  workMilestoneApprovePost,
] as const;

// SRV-1407 (Plan M2, D-204): a mentorship comes into being only when the
// teacher a student asked approves the request. The request moves
// requested -> approved | declined | withdrawn, once; each route below is one
// of those moves on one request, named by its path. The teacher's list of open
// requests is teacher.mentorship-requests.get (SRV-27), unchanged; the older
// teacher.mentorship-request-decision.post stays for its clients.
import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

import { MUTATION_GUARD } from "./shared.ts";
import { CODE_POINT, END } from "./teacher.ts";

const PATH = "/api/v1/mentorship-requests";
const INVENTORY = "app/api/mentorship-requests";
/** A UUID in any case; the server reads it in lowercase. */
const AnyCaseUuid = Type.String({
  pattern: `^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}${END}`,
});
/** Lowercase UUID, as the database returns it. */
const Uuid = Type.String({
  pattern: `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}${END}`,
});
const WorkType = Type.Union([
  Type.Literal("bachelor_thesis"),
  Type.Literal("master_thesis"),
  Type.Literal("specialist_thesis"),
  Type.Literal("doctoral_thesis"),
]);
/** As teacher.mentorship-request-decision.post: 1 to 600 code points, not blank. */
const DeclineReason = Type.String({
  pattern: `^(?=[\\s\\S]*\\S)(?:${CODE_POINT}|[^\\u0000\\uD800-\\uDFFF]){1,600}${END}`,
});
const params = closed({ requestId: Type.String({ minLength: 1 }) });
const json = { contentType: "application/json" } as const;
const BASE_ERRORS = [
  ...MUTATION_GUARD,
  error(401, "unauthorized"),
  error(404, "not_found"),
  error(409, "conflict"),
  error(503, "unavailable"),
] as const;
const BODY_ERRORS = [
  ...BASE_ERRORS,
  error(415, "unsupported_media_type"),
  error(400, "invalid_json"),
  error(422, "invalid_input"),
] as const;
const answer = (state: string) => closed({ requestId: Uuid, state: Type.Literal(state) });

export const mentorshipRoutes = [
  defineRoute({
    id: "mentorship.requests.post",
    method: "POST",
    path: PATH,
    inventory: `${INVENTORY}/route.ts`,
    access: "student",
    summary:
      "The student asks a confirmed teacher of the own institution to mentor one work of a kind. Creates no mentorship. A teacher who is unknown, of another institution, unconfirmed, revoked or the caller reads 404; an open request or an open mentorship of the kind is 409.",
    request: {
      ...json,
      maxBodyBytes: 1024,
      body: closed({ teacherId: AnyCaseUuid, workType: WorkType }),
    },
    responses: [
      {
        status: 201,
        description: "the open request",
        body: answer("requested"),
        headers: ["cache-control"],
      },
    ],
    errors: BODY_ERRORS,
  }),
  defineRoute({
    id: "mentorship.request-approve.post",
    method: "POST",
    path: `${PATH}/{requestId}/approve`,
    inventory: `${INVENTORY}/[requestId]/approve/route.ts`,
    access: "teacher",
    summary:
      "The confirmed teacher the request was made to approves it; the mentorship, its work and the first version exist from the commit on. Approving again answers the same mentorship and writes nothing. Anyone else, the student and another institution's teacher included, and an unknown or malformed id read 404; a declined or withdrawn request is 409; a missing faculty rule for the kind is 503. No body.",
    request: { params },
    responses: [
      {
        status: 200,
        description: "the approved request and its mentorship",
        body: closed({ requestId: Uuid, state: Type.Literal("approved"), mentorshipId: Uuid }),
        headers: ["cache-control"],
      },
    ],
    errors: BASE_ERRORS,
  }),
  defineRoute({
    id: "mentorship.request-decline.post",
    method: "POST",
    path: `${PATH}/{requestId}/decline`,
    inventory: `${INVENTORY}/[requestId]/decline/route.ts`,
    access: "teacher",
    summary:
      "The confirmed teacher the request was made to declines it. The optional reason (1 to 600 code points, not blank) stays in the audit record; the student is not shown it. Declining again answers the same and writes nothing. Anyone else and an unknown or malformed id read 404; an approved or withdrawn request is 409.",
    request: {
      ...json,
      maxBodyBytes: 8192,
      params,
      body: closed({ reason: Type.Optional(DeclineReason) }),
    },
    responses: [
      {
        status: 200,
        description: "the declined request",
        body: answer("declined"),
        headers: ["cache-control"],
      },
    ],
    errors: BODY_ERRORS,
  }),
  defineRoute({
    id: "mentorship.request-withdraw.post",
    method: "POST",
    path: `${PATH}/{requestId}/withdraw`,
    inventory: `${INVENTORY}/[requestId]/withdraw/route.ts`,
    access: "student",
    summary:
      "The student withdraws the own open request. Withdrawing again answers the same and writes nothing. Anyone else and an unknown or malformed id read 404; an approved or declined request is 409. No body.",
    request: { params },
    responses: [
      {
        status: 200,
        description: "the withdrawn request",
        body: answer("withdrawn"),
        headers: ["cache-control"],
      },
    ],
    errors: BASE_ERRORS,
  }),
] as const;

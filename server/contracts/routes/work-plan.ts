import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

import { MUTATION_GUARD } from "./shared.ts";

// SRV-F4-PM2-R15 (Ductus#2059; F4-PM2-R15-SRV, plan M5.14b, owner decisions D-234
// and D-250): the plan of a work behind the panel "Struktura" (S-14), kept on the
// server per work: the question of the work (the thesis), the purpose of each
// chapter and the glossary. The plan is not a change of the document (D-234
// point 1): it is in no evidence, no live view (D-142) and no reproduction
// (D-143), and writes no revision, segment, receipt or hash.
//
// Only the student who owns the work reads and writes it; to anyone else, the
// mentor and the teachers of the work included (D-234 point 2), and for an
// unknown or malformed work it is 404 (C-23). The plan is written whole: the
// student's device sends the question, every purpose and every term, so an edit,
// a removal and an emptied plan are one call. A plan with no question, no purpose
// and no term is not kept. It may be written while the work is under revision
// (D-234 point 6). The server never reads the plan against the document: a
// chapter is the id of its heading block, as a text anchor's nodeId, and a purpose
// whose chapter is gone is the client's to drop.
//
// Identity, role and institution are never in a request: the RPCs of
// 20261220380000 take them from the session (server/database/work-plan).

const CODE_POINT = "[\\uD800-\\uDBFF][\\uDC00-\\uDFFF]";
const END = "(?![\\s\\S])";
/** isDocumentId: 1 to 256 code points, trimmed, no control character (as live.ts). */
const WorkId = Type.String({
  pattern: `^(?!\\s)(?:${CODE_POINT}|[^\\u0000-\\u001f\\u007f-\\u009f\\uD800-\\uDFFF]){1,256}(?<!\\s)${END}`,
});
/** The instant as Date.toISOString writes it, in UTC. */
const Instant = Type.String({
  pattern: `^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z${END}`,
});
const BlockId = Type.String({
  pattern:
    "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$",
});

/** The most chapter purposes and the most terms a plan keeps. */
export const WORK_PLAN_MAX_ITEMS = 200;
export const WORK_PLAN_QUESTION_MAX = 300;
export const WORK_PLAN_PURPOSE_MAX = 300;
export const WORK_PLAN_TERM_MAX = 80;
export const WORK_PLAN_DEFINITION_MAX = 500;
/** What the schema allows at most, in UTF-8 bytes: the body bound. */
const BODY_MAX_BYTES = 1024 * 1024;

/**
 * One line of 1 to max code points: no control character, no space at either
 * end. NFC and no bidi control stay the server's (422).
 */
const line = (max: number) =>
  Type.String({
    pattern: `^(?!\\s)(?:${CODE_POINT}|[^\\u0000-\\u001f\\u007f-\\u009f\\uD800-\\uDFFF]){1,${max}}(?<!\\s)${END}`,
  });

export const WORK_PLAN_TERM_KINDS = ["term", "abbreviation"] as const;
const TermKind = Type.Union(WORK_PLAN_TERM_KINDS.map((kind) => Type.Literal(kind)));

const Purpose = closed({ nodeId: BlockId, purpose: line(WORK_PLAN_PURPOSE_MAX) });
const Term = closed({
  term: line(WORK_PLAN_TERM_MAX),
  definition: line(WORK_PLAN_DEFINITION_MAX),
  kind: TermKind,
});

/**
 * What the owner keeps on a work. No plan is `question: null`, no purposes, no
 * terms and `updatedAt: null`.
 */
export const WorkPlanState = closed({
  question: Type.Union([Type.String(), Type.Null()]),
  purposes: Type.Array(Purpose, { maxItems: WORK_PLAN_MAX_ITEMS }),
  terms: Type.Array(Term, { maxItems: WORK_PLAN_MAX_ITEMS }),
  updatedAt: Type.Union([Instant, Type.Null()]),
});

/** The whole plan as the device keeps it; a block id once, a term once (case aside). */
export const WorkPlanInput = closed({
  question: Type.Union([line(WORK_PLAN_QUESTION_MAX), Type.Null()]),
  purposes: Type.Array(Purpose, { maxItems: WORK_PLAN_MAX_ITEMS }),
  terms: Type.Array(Term, { maxItems: WORK_PLAN_MAX_ITEMS }),
});

const params = closed({ documentId: WorkId });
const OWNER_ONLY =
  "Only the student who owns the work; to anyone else, the mentor and the teachers of the work included, and for an unknown or malformed work it is 404.";

export const workPlanGet = defineRoute({
  id: "work.plan.get",
  method: "GET",
  path: "/api/v1/works/{documentId}/plan",
  inventory: "app/api/works/[documentId]/plan/route.ts",
  access: "student_owner",
  summary: `The plan of the work (D-234): the question, the purpose of each chapter and the glossary; no plan is a null question, empty lists and a null updatedAt. ${OWNER_ONLY}`,
  request: { params },
  responses: [{ status: 200, description: "the plan the owner keeps", body: WorkPlanState }],
  errors: [error(401, "unauthorized"), error(404, "not_found"), error(503, "unavailable")],
});

export const workPlanPut = defineRoute({
  id: "work.plan.put",
  method: "PUT",
  path: "/api/v1/works/{documentId}/plan",
  inventory: "app/api/works/[documentId]/plan/route.ts",
  access: "student_owner",
  summary: `Writes the whole plan, replacing the earlier one: {question, purposes, terms}. question null or a line of 1 to ${WORK_PLAN_QUESTION_MAX} characters; purposes up to ${WORK_PLAN_MAX_ITEMS} of {nodeId, purpose} (a block id once, purpose a line of 1 to ${WORK_PLAN_PURPOSE_MAX}); terms up to ${WORK_PLAN_MAX_ITEMS} of {term, definition, kind} (a term once, case aside; a line of 1 to ${WORK_PLAN_TERM_MAX}, a line of 1 to ${WORK_PLAN_DEFINITION_MAX}, kind term or abbreviation). A line is NFC with no control character, no bidi control and no space at its ends (422 otherwise). A plan with no question, no purpose and no term is not kept (deleting what is not there changes nothing). Answers the plan as kept. ${OWNER_ONLY}`,
  request: {
    params,
    contentType: "application/json",
    maxBodyBytes: BODY_MAX_BYTES,
    body: WorkPlanInput,
  },
  responses: [{ status: 200, description: "the plan the owner keeps", body: WorkPlanState }],
  errors: [
    ...MUTATION_GUARD,
    error(401, "unauthorized"),
    error(415, "unsupported_media_type"),
    error(400, "invalid_json"),
    error(422, "invalid_input"),
    error(404, "not_found"),
    error(503, "unavailable"),
  ],
});

export const workPlanRoutes = [workPlanGet, workPlanPut] as const;

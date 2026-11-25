import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

import { SegmentRef } from "./assistant-match.ts";
import { WorkId } from "./collaboration.ts";
import { MUTATION_GUARD } from "./shared.ts";

// SRV-0910 (Ductus#2052; P-1, rules 1 and 8, C-6): the composition of a work by
// the kind of origin of its changes, as a share per kind of a closed list. The
// answer is the same for the student who owns the work and for its readers
// (the teacher of the course, the teacher of the seminar group, the mentor): it
// has no parameter that could make two answers differ. It holds shares of
// characters per kind and nothing else: no key, no speed, no average, no
// profile, no comparison. A share says where text came from, never who wrote it
// (the client shows "Ovo nije dokaz autorstva" beside it). Database:
// app.work_origin_composition (20261213100300).

/** The closed list of the kinds of origin, in the order of the answer. */
export const ORIGIN_KINDS = [
  "typed",
  "assistant_inserted",
  "assistant_match",
  "imported_file",
  "pasted_known",
  "pasted_unknown",
] as const;
export type OriginKind = (typeof ORIGIN_KINDS)[number];

const Part = closed({
  kind: Type.Union(ORIGIN_KINDS.map((kind) => Type.Literal(kind))),
  /** Share of the characters of the work, 0 to 100, one decimal. */
  percent: Type.Number({ minimum: 0, maximum: 100 }),
});

export const originCompositionGet = defineRoute({
  id: "work.origin-composition.get",
  method: "GET",
  path: "/api/v1/works/{documentId}/origin-composition",
  inventory: "app/api/works/[documentId]/origin-composition/route.ts",
  access: "owner_or_course_teacher",
  summary:
    "The share of the characters of a work per kind of origin (typed, assistant_inserted, assistant_match, imported_file, pasted_known, pasted_unknown), always all six in this order, all 0 while nothing is recorded. The same answer for the student who owns the work and for its readers. It is a record of where text came from, not of who wrote it. Another's, an unknown or a malformed work returns 404.",
  request: { params: closed({ documentId: WorkId }) },
  responses: [
    {
      status: 200,
      description: "the share per kind",
      body: closed({ parts: Type.Array(Part, { minItems: 6, maxItems: 6 }) }),
    },
  ],
  errors: [error(401, "unauthorized"), error(404, "not_found"), error(503, "unavailable")],
});

// SRV-KARTA-RASPON (Ductus#2055; P-1, NF-5 PG-2): where in a revision each kind
// of origin stands, so that the map of origin can mark it per paragraph. The
// same kinds as the composition; a range of code points of one block of the
// revision (start inclusive, end exclusive, as textBlocksOf counts them). A
// range recorded with the segmentRef of work.assistant-match.post carries it, so
// a finding resolves to its ranges. The ranges are those of the latest recorded
// revision at or below the one asked; the answer names that revision. Like the
// composition: the same answer for the owner and the readers, no text, no key,
// no time, no measure, and nothing about who typed. Database:
// app.work_origin_segments (20261218100000).

/** The most ranges of one revision. */
export const ORIGIN_SEGMENTS_MAX = 10_000;
/** The end of a range, in code points of a block (exclusive). */
export const ORIGIN_SEGMENT_END_MAX = 10_000_000;

/** A block of the document: its node id (isNodeId). */
const BlockId = Type.String({
  pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
});
const SegmentRevision = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });

const Segment = closed({
  blockId: BlockId,
  /** The first code point of the range in the block's text. */
  start: Type.Integer({ minimum: 0, maximum: ORIGIN_SEGMENT_END_MAX - 1 }),
  /** The code point after the last one of the range (exclusive), above start. */
  end: Type.Integer({ minimum: 1, maximum: ORIGIN_SEGMENT_END_MAX }),
  kind: Type.Union(ORIGIN_KINDS.map((kind) => Type.Literal(kind))),
  /** The segmentRef of work.assistant-match.post for this text, or null. */
  segmentRef: Type.Union([SegmentRef, Type.Null()]),
});

export const originSegmentsGet = defineRoute({
  id: "work.origin-segments.get",
  method: "GET",
  path: "/api/v1/works/{documentId}/origin-segments",
  inventory: "app/api/works/[documentId]/origin-segments/route.ts",
  access: "owner_or_course_teacher",
  summary:
    "The ranges of origin of one revision of a work, in the order recorded: the block (its node id), the range of code points of the block's text (start inclusive, end exclusive), the kind from the same closed list as work.origin-composition.get, and the segmentRef of work.assistant-match.post when the range was recorded with one (null otherwise), so a finding of the match resolves to its ranges. The ranges are those of the latest recorded revision at or below ?revision (the latest of all without it); revision names it, null with no ranges while none is recorded. A paste explained later reads pasted_known. The same answer for the student who owns the work and for its readers. It says where text came from, not who wrote it. A revision that is not a whole number up to 2^53-1 is 422. Another's, an unknown or a malformed work returns 404.",
  request: {
    params: closed({ documentId: WorkId }),
    query: closed({
      revision: Type.Optional(Type.String({ pattern: "^(?:0|[1-9][0-9]{0,15})$" })),
    }),
  },
  responses: [
    {
      status: 200,
      description: "the ranges of the revision, possibly none",
      body: closed({
        revision: Type.Union([SegmentRevision, Type.Null()]),
        segments: Type.Array(Segment, { maxItems: ORIGIN_SEGMENTS_MAX }),
      }),
    },
  ],
  errors: [
    error(401, "unauthorized"),
    error(404, "not_found"),
    error(422, "invalid_input"),
    error(503, "unavailable"),
  ],
});

// SRV-KARTA-RASPON-RUTA (Ductus#2055, variant A): the student who owns the work
// records the ranges of a revision they saved, once; the readers only read them
// through work.origin-segments.get. Database: app.work_origin_segments_record
// (20261218100000), which checks the revision, ownership and every range again.

/** The largest body of a write of ranges. */
export const ORIGIN_SEGMENTS_MAX_BODY_BYTES = 2 * 1024 * 1024;

const SegmentInput = closed({
  blockId: BlockId,
  start: Type.Integer({ minimum: 0, maximum: ORIGIN_SEGMENT_END_MAX - 1 }),
  end: Type.Integer({ minimum: 1, maximum: ORIGIN_SEGMENT_END_MAX }),
  kind: Type.Union(ORIGIN_KINDS.map((kind) => Type.Literal(kind))),
  segmentRef: Type.Optional(SegmentRef),
  /** The origin change of this work the range comes from (same kind). */
  changeId: Type.Optional(
    Type.String({ pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$" }),
  ),
});

export const originSegmentsPost = defineRoute({
  id: "work.origin-segments.post",
  method: "POST",
  path: "/api/v1/works/{documentId}/origin-segments",
  inventory: "app/api/works/[documentId]/origin-segments/route.ts",
  access: "student_owner",
  summary:
    "The student who owns the work records the ranges of origin of one revision they saved, exactly {revision, segments}: 1 to 10000 ranges, each {blockId, start, end, kind, segmentRef?, changeId?} as work.origin-segments.get reads them, end above start; pasted_known only with the changeId of an explained change of the same kind. Recorded once per revision and never rewritten: a second write of the same revision is 409. Answers 201 with the revision and the number of ranges recorded. A body that is not exactly this, a range that is empty or a revision the student did not save is 422. Anyone but the owner of the work (the teacher too) and an unknown or malformed work get 404. It says where text came from, not who wrote it.",
  request: {
    params: closed({ documentId: WorkId }),
    contentType: "application/json",
    maxBodyBytes: ORIGIN_SEGMENTS_MAX_BODY_BYTES,
    body: closed({
      revision: SegmentRevision,
      segments: Type.Array(SegmentInput, { minItems: 1, maxItems: ORIGIN_SEGMENTS_MAX }),
    }),
  },
  responses: [
    {
      status: 201,
      description: "the ranges are recorded",
      body: closed({
        revision: SegmentRevision,
        recorded: Type.Integer({ minimum: 1, maximum: ORIGIN_SEGMENTS_MAX }),
      }),
    },
  ],
  errors: [
    ...MUTATION_GUARD,
    error(401, "unauthorized"),
    error(415, "unsupported_media_type"),
    error(400, "invalid_json"),
    error(422, "invalid_input"),
    error(404, "not_found"),
    error(409, "conflict"),
    error(503, "unavailable"),
  ],
});

export const originCompositionRoutes = [
  originCompositionGet,
  originSegmentsGet,
  originSegmentsPost,
] as const;

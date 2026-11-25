import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

import { MUTATION_GUARD } from "./shared.ts";

// SRV-V18-KODIRANJE-OZNAKE (Ductus#2058, val 18; docs/nalazi/val18-razlika.md in
// the web repo, task 8, findings V18-3, V18-7, V18-8, V18-9): the passages a
// student marks in their own material with a code of their own codebook, and the
// export of the coding (qualitative-export-v1). All of it is the student's own
// and nobody else's: a teacher, a mentor and another student read the same 404
// as for an unknown id (C-23). The export lists the codebook in its own order,
// then the materials in the order they were kept in, then the text: never by how
// often a code is used (V18-8). No route here suggests a code, marks anything by
// itself or calls the assistant (V18-3). Database: app.create_qual_segment,
// app.qual_segments, app.delete_qual_segment and app.qual_export_segments
// (20261219390000). The text is in docs/contracts/qualitative-segments-v1.md and
// docs/contracts/qualitative-export-v1.md.

const Uuid = `[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}`;
const Id = Type.String({ pattern: "^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$" });
/** A path id: the same shape, either case; a malformed one is the same 404. */
const IdParam = Type.String({ pattern: `^${Uuid}$` });
const Day = Type.String({ pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" });

/** The longest quote of a passage, in characters (code points). */
export const QUAL_QUOTE_MAX = 500;
/** The longest memo of a passage, in characters (code points). */
export const QUAL_MEMO_MAX = 1000;
/** The most passages one material keeps (the database refuses the next with a conflict). */
export const QUAL_SEGMENTS_MAX = 5000;
/** The most materials and codes a student keeps; the export holds all their passages. */
export const QUAL_EXPORT_SEGMENTS_MAX = 1_000_000;
const OFFSET_MAX = 100_000;
const Offset = Type.Integer({ minimum: 0, maximum: OFFSET_MAX });
// The quote and the memo are checked by the domain, which counts characters
// (code points) and knows what an anchor of the text is; the contract bounds the
// UTF-16 length (a code point is at most two units).
const Quote = Type.String({ minLength: 1, maxLength: QUAL_QUOTE_MAX * 2 });
const Memo = Type.String({ minLength: 1, maxLength: QUAL_MEMO_MAX * 2 });
const Name = Type.String({ minLength: 1, maxLength: 80 * 2 });
const Description = Type.String({ minLength: 0, maxLength: 500 * 2 });

const Anchor = closed({ paragraph: Offset, start: Offset, end: Offset, quote: Quote });

export const QualSegment = closed({
  id: Id,
  codeId: Id,
  paragraph: Offset,
  start: Offset,
  end: Offset,
  quote: Quote,
  memo: Type.Union([Memo, Type.Null()]),
  createdOn: Day,
});
const Segments = closed({
  segments: Type.Array(QualSegment, { maxItems: QUAL_SEGMENTS_MAX }),
});
const NewSegment = closed({ codeId: Id, anchor: Anchor, memo: Type.Optional(Memo) });

export const QUALITATIVE_EXPORT_SCHEMA = "qualitative-export-v1";
export const QualExport = closed({
  schema: Type.Literal(QUALITATIVE_EXPORT_SCHEMA),
  codebook: Type.Array(closed({ code: Id, name: Name, description: Description }), {
    maxItems: 200,
  }),
  segments: Type.Array(
    closed({
      material: Id,
      code: Id,
      paragraph: Offset,
      start: Offset,
      end: Offset,
      quote: Quote,
      memo: Type.Union([Memo, Type.Null()]),
    }),
    { maxItems: QUAL_EXPORT_SEGMENTS_MAX },
  ),
  counts: Type.Array(closed({ code: Id, material: Id, n: Type.Integer({ minimum: 1 }) }), {
    maxItems: QUAL_EXPORT_SEGMENTS_MAX,
  }),
});

const MaterialParams = closed({ id: IdParam });
const SegmentParams = closed({ id: IdParam });

const MATERIAL_SEGMENTS_PATH = "/api/v1/student/qual/materials/{id}/segments";
const MATERIAL_SEGMENTS_INVENTORY = "app/api/student/qual/materials/[id]/segments/route.ts";
const SEGMENT_PATH = "/api/v1/student/qual/segments/{id}";
const SEGMENT_INVENTORY = "app/api/student/qual/segments/[id]/route.ts";
const EXPORT_PATH = "/api/v1/student/qual/export";
const EXPORT_INVENTORY = "app/api/student/qual/export/route.ts";
const READ_ERRORS = [error(401, "unauthorized"), error(503, "unavailable")] as const;
const ID_ERRORS = [...READ_ERRORS, error(404, "not_found")] as const;

export const studentQualSegmentsGet = defineRoute({
  id: "student.qual-segments.get",
  method: "GET",
  path: MATERIAL_SEGMENTS_PATH,
  inventory: MATERIAL_SEGMENTS_INVENTORY,
  access: "student",
  request: { params: MaterialParams },
  summary:
    "Reads the passages the caller has marked in one of their own materials, in the order of the text (paragraph, start, end): code, place, quote, memo (null when there is none) and the day it was marked. A material of someone else, an unknown id and a malformed id are the same 404.",
  responses: [{ status: 200, description: "the marked passages", body: Segments }],
  errors: ID_ERRORS,
});

export const studentQualSegmentsPost = defineRoute({
  id: "student.qual-segments.post",
  method: "POST",
  path: MATERIAL_SEGMENTS_PATH,
  inventory: MATERIAL_SEGMENTS_INVENTORY,
  access: "student",
  request: {
    params: MaterialParams,
    contentType: "application/json",
    maxBodyBytes: 8192,
    body: NewSegment,
  },
  summary:
    "Marks a passage of one of the caller's own materials with one of the caller's own codes: exactly {codeId, anchor{paragraph, start, end, quote}, memo?}. The anchor is characters start..end (0-based, end exclusive, counted in characters) of line number paragraph of the text, and the quote must be exactly those characters, 1..500 of them and not only blank (422 invalid_input otherwise). The memo is 1..1000 characters, or left out. A material or a code that is not the caller's, an unknown one and a malformed id are the same 404. The same mark again (same code and place) and the 5001st passage of a material are 409 conflict. Marking locks the material: its text cannot change anyway. Answers 201 with the passage. Nothing marks or suggests a code by itself.",
  responses: [{ status: 201, description: "the marked passage", body: QualSegment }],
  errors: [
    ...MUTATION_GUARD,
    ...ID_ERRORS,
    error(415, "unsupported_media_type"),
    error(400, "invalid_json"),
    error(409, "conflict"),
    error(422, "invalid_input"),
  ],
});

export const studentQualSegmentDelete = defineRoute({
  id: "student.qual-segment.delete",
  method: "DELETE",
  path: SEGMENT_PATH,
  inventory: SEGMENT_INVENTORY,
  access: "student",
  request: { params: SegmentParams },
  summary:
    "Removes one marked passage of the caller. A passage of someone else, an unknown id and a malformed id are the same 404.",
  responses: [{ status: 204, description: "removed" }],
  errors: [...MUTATION_GUARD, ...ID_ERRORS],
});

export const studentQualExportGet = defineRoute({
  id: "student.qual-export.get",
  method: "GET",
  path: EXPORT_PATH,
  inventory: EXPORT_INVENTORY,
  access: "student",
  request: { query: closed({ materialId: Type.Optional(Type.String({ maxLength: 64 })) }) },
  summary:
    "The caller's coding as qualitative-export-v1: the codebook (code, name, description) in its own order, the marked passages (material, code, place, quote, memo) in the order of the codebook, then of the materials in the order they were kept in, then of the text, and the count of passages per code and material in the same order. Never ordered by the count, with no 'most often' and no comparison of materials (V18-8). With the query materialId only that material's passages (and counts) are listed; a material that is not the caller's, an unknown and a malformed materialId are the same 404; any other query, or materialId twice, is 422 invalid_input. The same coding gives the same bytes. Only the owner reads it; it is a description to be carried away, not a verdict.",
  responses: [{ status: 200, description: "qualitative-export-v1", body: QualExport }],
  errors: [...ID_ERRORS, error(422, "invalid_input")],
});

export const qualitativeSegmentsRoutes = [
  studentQualSegmentsGet,
  studentQualSegmentsPost,
  studentQualSegmentDelete,
  studentQualExportGet,
] as const;

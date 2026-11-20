import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

import { MUTATION_GUARD } from "./shared.ts";
import { CODE_POINT, END } from "./teacher.ts";

// SRV-7C (Ductus#2028, wave 7 "Citati i izvori"): the HTTP face of the work's
// source list (SRV-7B, institution.work_source). One list per work; the
// student adds, changes and removes the sources they added, and reads the
// whole list, which also holds the sources a teacher recommended or required.
// The record is the source record of the document schema (v2 section 2, the
// one source model of D-226); DOI, ISBN and "no year" sit beside it (v3
// contract, "izbor ugovora"), because the record itself has no room for them.
// The list is not evidence: it is outside the document and its hash.

/** A lowercase UUID, as PostgreSQL writes uuid. */
const LowerUuid = Type.String({
  pattern: `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}${END}`,
});
/** The id of a source record: a version 4 UUID (v2 section 2.1). */
const SourceId = Type.String({
  pattern: `^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}${END}`,
});
const Instant = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$" });

/**
 * The FORBIDDEN code points of the document schema (v2 section 3.2,
 * server/domain/document/forbidden.ts; contracts import nothing from the
 * server, so the list is repeated here and kept equal by the test).
 */
const FORBIDDEN =
  "\\u0000-\\u001f\\u007f-\\u009f\\u00ad\\u061c\\u180e\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u2064\\u2066-\\u206f\\ufeff";

/**
 * A text field of a source record (v2 section 2.3): 1 to `max` code points, no
 * FORBIDDEN code point, no white space at either end. A lone surrogate is refused.
 */
const Text = (max: number) =>
  Type.String({
    pattern: `^(?!\\s)(?:${CODE_POINT}|[^${FORBIDDEN}\\uD800-\\uDFFF]){1,${max}}(?<!\\s)${END}`,
  });

const Person = closed({
  kind: Type.Literal("person"),
  family: Text(200),
  given: Text(200),
});
const Organization = closed({
  kind: Type.Literal("organization"),
  name: Text(300),
  acronym: Type.Optional(Text(50)),
});
const Authors = Type.Array(Type.Union([Person, Organization]), { minItems: 1, maxItems: 50 });
const Year = Type.Integer({ minimum: 1000, maximum: 9999 });
const Url = Type.String({ pattern: `^https?://[\\x21-\\x7e]*${END}`, maxLength: 2048 });
// A real calendar date (the validator's isAccessedDate): 30 and 31 day months,
// February to the 28th, and the 29th only in a leap year.
const MULTIPLE_OF_FOUR = "(?:0[48]|[2468][048]|[13579][26])";
const LEAP_YEAR = `(?:\\d{2}${MULTIPLE_OF_FOUR}|${MULTIPLE_OF_FOUR}00)`;
const AccessedDate = Type.String({
  pattern:
    "^(?:\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|02-(?:0[1-9]|1\\d|2[0-8]))" +
    `|${LEAP_YEAR}-02-29)${END}`,
});

const common = { id: SourceId, authors: Authors, year: Year, title: Text(1000) };

/** The source record of the document schema (v2 section 2.1), one shape per type. */
export const WorkSourceRecord = Type.Union([
  closed({
    ...common,
    type: Type.Literal("book"),
    place: Text(200),
    publisher: Text(300),
  }),
  closed({
    ...common,
    type: Type.Literal("article"),
    journal: Text(500),
    volume: Type.Optional(Text(50)),
    issue: Type.Optional(Text(50)),
    pages: Type.Optional(Text(50)),
  }),
  closed({
    ...common,
    type: Type.Literal("chapter"),
    editors: Type.Array(Person, { minItems: 1, maxItems: 20 }),
    bookTitle: Text(1000),
    place: Text(200),
    publisher: Text(300),
    pages: Type.Optional(Text(50)),
  }),
  closed({ ...common, type: Type.Literal("web"), url: Url, accessed: AccessedDate }),
]);

/** One spelling each: a DOI in lowercase, an ISBN as its digits (ISBN-10 may end in X). */
const Doi = Type.String({ pattern: `^10\\.[0-9]{4,9}/[!-@\\[-~]{1,300}${END}`, maxLength: 300 });
const Isbn = Type.String({ pattern: `^(?:[0-9]{9}[0-9X]|97[89][0-9]{10})${END}` });

/** What the student sends for one source: the record and what the record has no room for. */
const SourceInput = closed({
  /**
   * An object of the shape of the response's record (WorkSourceRecord). The
   * ahead-of-time input validator compiles one level of nesting only, so the
   * server checks the deep shape against WorkSourceRecord itself; an object
   * of another shape answers 422.
   */
  record: Type.Object({}, { additionalProperties: true }),
  doi: Type.Optional(Type.Union([Doi, Type.Null()])),
  isbn: Type.Optional(Type.Union([Isbn, Type.Null()])),
  /** The source has no year (shown "b. g."); the record still holds one. */
  undated: Type.Optional(Type.Boolean()),
});

const WorkSource = closed({
  id: SourceId,
  record: WorkSourceRecord,
  doi: Type.Union([Doi, Type.Null()]),
  isbn: Type.Union([Isbn, Type.Null()]),
  undated: Type.Boolean(),
  /** Set by a teacher of the work; a source with a requirement is not the student's to change. */
  requirement: Type.Union([Type.Literal("recommended"), Type.Literal("required"), Type.Null()]),
  createdAt: Instant,
  updatedAt: Instant,
});

const sourceParams = closed({
  assignmentId: Type.String({ minLength: 1 }),
  sourceId: Type.String({ minLength: 1 }),
});
const READ_ERRORS = [
  error(401, "unauthorized"),
  error(404, "not_found"),
  error(503, "unavailable"),
] as const;

export const studentWorkSourcesGet = defineRoute({
  id: "student.work-sources.get",
  method: "GET",
  path: "/api/v1/student/assignments/{assignmentId}/sources",
  inventory: "app/api/student/assignments/[assignmentId]/sources/route.ts",
  access: "student_enrolled",
  summary:
    "The sources of the caller's work on an accessible assignment, oldest first, then by id: the ones the caller added and the ones a teacher recommended or required (requirement). An inaccessible, unknown or malformed assignment id returns 404.",
  request: { params: closed({ assignmentId: Type.String({ minLength: 1 }) }) },
  responses: [
    {
      status: 200,
      description: "sources, possibly empty",
      body: closed({ sources: Type.Array(WorkSource, { maxItems: 500 }) }),
    },
  ],
  errors: READ_ERRORS,
});

export const studentWorkSourcePut = defineRoute({
  id: "student.work-sources.put",
  method: "PUT",
  path: "/api/v1/student/assignments/{assignmentId}/sources/{sourceId}",
  inventory: "app/api/student/assignments/[assignmentId]/sources/[sourceId]/route.ts",
  access: "student_enrolled",
  summary:
    "Adds the caller's source or changes one the caller added; the source id is chosen by the client and must equal record.id. A work holds at most 500 sources. A source with a requirement is a teacher's: it is not changed here and answers 404, as does an inaccessible work.",
  request: {
    params: sourceParams,
    contentType: "application/json",
    maxBodyBytes: 65536,
    body: SourceInput,
  },
  responses: [{ status: 200, description: "the saved source", body: WorkSource }],
  errors: [
    ...MUTATION_GUARD,
    ...READ_ERRORS,
    error(415, "unsupported_media_type"),
    error(400, "invalid_json"),
    error(422, "invalid_input"),
  ],
});

export const studentWorkSourceDelete = defineRoute({
  id: "student.work-sources.delete",
  method: "DELETE",
  path: "/api/v1/student/assignments/{assignmentId}/sources/{sourceId}",
  inventory: "app/api/student/assignments/[assignmentId]/sources/[sourceId]/route.ts",
  access: "student_enrolled",
  summary:
    "Removes a source the caller added. A source that is not there, a teacher's source (with a requirement) and an inaccessible work all answer 404.",
  request: { params: sourceParams },
  responses: [{ status: 204, description: "removed" }],
  errors: [...MUTATION_GUARD, ...READ_ERRORS],
});

export const studentSourcesRoutes = [
  studentWorkSourcesGet,
  studentWorkSourcePut,
  studentWorkSourceDelete,
] as const;

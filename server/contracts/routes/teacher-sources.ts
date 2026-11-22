import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

import { WorkId } from "./collaboration.ts";
import { MUTATION_GUARD } from "./shared.ts";
import { Note, Page } from "./source-proofs.ts";
import {
  Doi,
  Instant,
  Isbn,
  LowerUuid,
  SourceId,
  SourceInput,
  WorkSource,
  WorkSourceRecord,
} from "./student-sources.ts";
import { CODE_POINT, END } from "./teacher.ts";

// SRV-1605 (Ductus#2052; WEB-2133, paritet-editor prijedlog 11): the guidance of
// a teacher on sources. Database: 20261213100500 (institution.course_required_source,
// institution.source_proof_request, institution.work_literature_seen and the
// app.teacher_* and app.course_literature_* RPCs).
//
//   teacher.source-guidance.get              the sources of a work, the proof requests and the mark (s2Rec read)
//   teacher.source-recommendation.put/delete a source recommended or required on a work (s2Rec, s2RecDel)
//   teacher.course-literature.get/put/delete the required literature of a course (s2ObNew, s2ObDel)
//   teacher.source-proof-request.put/delete  a request for a proof with an instruction and a deadline (s2Req, s2ReqDel)
//   teacher.literature-seen.put              the literature of a work was reviewed (litSeen)
//   teacher.source-proofs.get                the proofs of a source of a work (source proofs)
//   teacher.source-proof-image.get           the JPEG bytes of one proof
//   student.course-literature.get            the required literature of an own course
//   student.source-proof-requests.get        the proof requests of the own work
//
// Only the holder of the course of a work (or the mentor of a mentorship work)
// writes; a collaborator, a seminar group teacher and every other reader of the
// work only read (INVENTAR 7 point 5). The student of a work sees the
// recommendations in the work source list (student.work-sources.get), the proof
// requests and the required literature of an own course. Another's, an unknown
// or a malformed work or course, a caller with no relation and a reader that is
// not a writer on a write are all the same 404 (C-23): the answer does not say
// which. canWrite tells a reader whether the page may offer the writes. None of
// these is evidence: they are outside the document and its hash.

/** A request for a proof of a source, as the teacher and the student read it. */
export const ProofRequest = closed({
  id: LowerUuid,
  sourceId: SourceId,
  /** What the student is asked to attach: 1 to 1000 code points, line breaks allowed. */
  instruction: Type.String({
    pattern: `^(?!\\s)(?:${CODE_POINT}|\\n|[^\\u0000-\\u001f\\u007f-\\u009f\\uD800-\\uDFFF]){1,1000}(?<!\\s)${END}`,
  }),
  dueAt: Instant,
  createdAt: Instant,
  /** Null while the request is open. A closed request stays in the history. */
  closedAt: Type.Union([Instant, Type.Null()]),
});

/** A source of a work with the number of proofs attached to it. */
const GuidanceSource = closed({
  ...WorkSource.properties,
  proofCount: Type.Integer({ minimum: 0, maximum: 200 }),
});

/** A required source of a course (it has no requirement: it is all required). */
export const CourseSource = closed({
  id: SourceId,
  record: WorkSourceRecord,
  doi: Type.Union([Doi, Type.Null()]),
  isbn: Type.Union([Isbn, Type.Null()]),
  undated: Type.Boolean(),
  createdAt: Instant,
  updatedAt: Instant,
});

const workParams = closed({ documentId: WorkId });
const sourceOfWorkParams = closed({
  documentId: WorkId,
  sourceId: Type.String({ minLength: 1 }),
});
const courseParams = closed({ courseId: Type.String({ minLength: 1 }) });
const sourceOfCourseParams = closed({
  courseId: Type.String({ minLength: 1 }),
  sourceId: Type.String({ minLength: 1 }),
});

const READ_ERRORS = [
  error(401, "unauthorized"),
  error(404, "not_found"),
  error(503, "unavailable"),
] as const;
const WRITE_ERRORS = [
  ...MUTATION_GUARD,
  ...READ_ERRORS,
  error(415, "unsupported_media_type"),
  error(400, "invalid_json"),
  error(422, "invalid_input"),
] as const;
/** A write with no body: the framing errors of the guard, no media type, no JSON. */
const BODYLESS_WRITE_ERRORS = [...MUTATION_GUARD, ...READ_ERRORS] as const;

const WORKS = "/api/v1/teacher/works/{documentId}";
const WORKS_INV = "app/api/teacher/works/[documentId]";
const COURSES = "/api/v1/teacher/courses/{courseId}/required-literature";
const COURSES_INV = "app/api/teacher/courses/[courseId]/required-literature";

export const teacherSourceGuidanceGet = defineRoute({
  id: "teacher.source-guidance.get",
  method: "GET",
  path: `${WORKS}/source-guidance`,
  inventory: `${WORKS_INV}/source-guidance/route.ts`,
  access: "course_teacher",
  summary:
    "The guidance on the sources of one work, for a reader of it: every source of the work, oldest first then by id (the student's own and the recommended or required ones, each with the number of proofs attached to it), the proof requests oldest first (open and closed), and literatureSeenAt, the time a teacher marked the literature of the work as reviewed (null before). canWrite is true for the holder of the course and the mentor of a mentorship work and false for every other reader; the page offers the writes only then. The student of the work, another teacher, an unknown work and a malformed id all read the same 404.",
  request: { params: workParams },
  responses: [
    {
      status: 200,
      description: "the guidance",
      body: closed({
        canWrite: Type.Boolean(),
        sources: Type.Array(GuidanceSource, { maxItems: 500 }),
        proofRequests: Type.Array(ProofRequest, { maxItems: 1000 }),
        literatureSeenAt: Type.Union([Instant, Type.Null()]),
      }),
      headers: ["cache-control"],
    },
  ],
  errors: READ_ERRORS,
});

export const teacherSourceRecommendationPut = defineRoute({
  id: "teacher.source-recommendation.put",
  method: "PUT",
  path: `${WORKS}/source-recommendations/{sourceId}`,
  inventory: `${WORKS_INV}/source-recommendations/[sourceId]/route.ts`,
  access: "course_teacher",
  summary:
    "The holder of the course of a work (or the mentor of a mentorship work) recommends or requires a source on the work: {record, requirement: recommended | required, doi?, isbn?, undated?}, at most 64 KiB, as the student's source of student.work-sources.put; the source id is chosen by the client and must equal record.id. The same id again changes it. The student reads it in the work's source list with its requirement. A work holds at most 500 sources. A collaborator or any other reader that is not a writer, the student of the work, a source of the student (without a requirement) and an inaccessible work answer 404. A record that does not fit its shape, a requirement outside the two or a full list is 422.",
  request: {
    params: sourceOfWorkParams,
    contentType: "application/json",
    maxBodyBytes: 65536,
    body: closed({
      ...SourceInput.properties,
      requirement: Type.Union([Type.Literal("recommended"), Type.Literal("required")]),
    }),
  },
  responses: [{ status: 200, description: "the saved source", body: WorkSource }],
  errors: WRITE_ERRORS,
});

export const teacherSourceRecommendationDelete = defineRoute({
  id: "teacher.source-recommendation.delete",
  method: "DELETE",
  path: `${WORKS}/source-recommendations/{sourceId}`,
  inventory: `${WORKS_INV}/source-recommendations/[sourceId]/route.ts`,
  access: "course_teacher",
  summary:
    "The holder of the course (or the mentor of a mentorship work) removes a recommended or required source from the work, with its proofs, notes and proof requests; 204 also when there was none. A source of the student (without a requirement) is not removed here and answers 404, as does a reader that is not a writer and an inaccessible work.",
  request: { params: sourceOfWorkParams },
  responses: [{ status: 204, description: "removed" }],
  errors: BODYLESS_WRITE_ERRORS,
});

export const teacherSourceProofRequestPut = defineRoute({
  id: "teacher.source-proof-request.put",
  method: "PUT",
  path: `${WORKS}/sources/{sourceId}/proof-request`,
  inventory: `${WORKS_INV}/sources/[sourceId]/proof-request/route.ts`,
  access: "course_teacher",
  summary:
    "The holder of the course (or the mentor of a mentorship work) asks the student for a proof of a source of the work: {instruction, dueAt}, at most 4 KiB; dueAt is an instant in the future (Date.toISOString). An open request of that source is changed, otherwise a new one is made, so a source has at most one open request. The student reads it in student.source-proof-requests.get. A source that is not in the work, a reader that is not a writer and an inaccessible work answer 404. An instruction that is empty, over 1000 code points or holds a control character, and a deadline that is not in the future, is 422.",
  request: {
    params: sourceOfWorkParams,
    contentType: "application/json",
    maxBodyBytes: 4096,
    body: closed({
      instruction: ProofRequest.properties.instruction,
      dueAt: Instant,
    }),
  },
  responses: [{ status: 200, description: "the open request", body: ProofRequest }],
  errors: WRITE_ERRORS,
});

export const teacherSourceProofRequestDelete = defineRoute({
  id: "teacher.source-proof-request.delete",
  method: "DELETE",
  path: `${WORKS}/sources/{sourceId}/proof-request`,
  inventory: `${WORKS_INV}/sources/[sourceId]/proof-request/route.ts`,
  access: "course_teacher",
  summary:
    "The holder of the course (or the mentor of a mentorship work) closes the open request for a proof of a source; the request stays in the history with its closing time. 204 also when there was no open request. A reader that is not a writer and an inaccessible work answer 404.",
  request: { params: sourceOfWorkParams },
  responses: [{ status: 204, description: "closed" }],
  errors: BODYLESS_WRITE_ERRORS,
});

export const teacherLiteratureSeenPut = defineRoute({
  id: "teacher.literature-seen.put",
  method: "PUT",
  path: `${WORKS}/literature-seen`,
  inventory: `${WORKS_INV}/literature-seen/route.ts`,
  access: "course_teacher",
  summary:
    "The holder of the course (or the mentor of a mentorship work) marks that the literature of the work was reviewed. No body. One mark per work: a later one replaces the earlier, and seenAt is the time of the database clock, as the guidance reads it. A reader that is not a writer, the student of the work and an inaccessible work answer 404.",
  request: { params: workParams },
  responses: [
    {
      status: 200,
      description: "the mark",
      body: closed({ seenAt: Instant }),
      headers: ["cache-control"],
    },
  ],
  errors: BODYLESS_WRITE_ERRORS,
});

/** One proof of a source of a work as a teacher reads it; imagePath is the GET of its JPEG bytes. */
const TeacherProof = closed({
  id: LowerUuid,
  page: Page,
  note: Type.Union([Note, Type.Null()]),
  imagePath: Type.String({
    pattern: `^/api/v1/teacher/works/[^/]{1,256}/sources/[0-9a-f-]{36}/proofs/[0-9a-f-]{36}/image${END}`,
  }),
});

export const teacherSourceProofsGet = defineRoute({
  id: "teacher.source-proofs.get",
  method: "GET",
  path: `${WORKS}/sources/{sourceId}/proofs`,
  inventory: `${WORKS_INV}/sources/[sourceId]/proofs/route.ts`,
  access: "course_teacher",
  summary:
    "The proofs (attached excerpts) of one source of a work, oldest first then by id, for any reader of the work (the holder, a collaborator, a seminar group teacher, the mentor). The student of the work reads them in student.source-proofs.get. A source that is not in the work, the student of the work, another teacher, an unknown work and a malformed id all answer 404.",
  request: { params: sourceOfWorkParams },
  responses: [
    {
      status: 200,
      description: "proofs, possibly empty",
      body: closed({ proofs: Type.Array(TeacherProof, { maxItems: 200 }) }),
    },
  ],
  errors: READ_ERRORS,
});

export const teacherSourceProofImageGet = defineRoute({
  id: "teacher.source-proof-image.get",
  method: "GET",
  path: `${WORKS}/sources/{sourceId}/proofs/{proofId}/image`,
  inventory: `${WORKS_INV}/sources/[sourceId]/proofs/[proofId]/image/route.ts`,
  access: "course_teacher",
  summary:
    "The JPEG bytes of one proof of a source of a work, for any reader of the work. The proof is named by its work, source and id together; another work's, another source's, an unknown or a malformed id and a caller that does not read the work answer 404.",
  request: {
    params: closed({
      documentId: WorkId,
      sourceId: Type.String({ minLength: 1 }),
      proofId: Type.String({ minLength: 1 }),
    }),
  },
  responses: [
    {
      status: 200,
      description: "the JPEG bytes of the excerpt",
      contentType: "image/jpeg",
      headers: ["cache-control"],
    },
  ],
  errors: READ_ERRORS,
});

export const teacherCourseLiteratureGet = defineRoute({
  id: "teacher.course-literature.get",
  method: "GET",
  path: COURSES,
  inventory: `${COURSES_INV}/route.ts`,
  access: "course_teacher",
  summary:
    "The required literature of a course, oldest first then by id, for a teacher of it. canWrite is true for the holder of the course and false for another teacher of it. A course the caller does not teach, a student, an unknown and a malformed id all answer 404. A student of the course reads it in student.course-literature.get.",
  request: { params: courseParams },
  responses: [
    {
      status: 200,
      description: "the required literature, possibly empty",
      body: closed({
        canWrite: Type.Boolean(),
        sources: Type.Array(CourseSource, { maxItems: 200 }),
      }),
      headers: ["cache-control"],
    },
  ],
  errors: READ_ERRORS,
});

export const teacherCourseLiteraturePut = defineRoute({
  id: "teacher.course-literature.put",
  method: "PUT",
  path: `${COURSES}/{sourceId}`,
  inventory: `${COURSES_INV}/[sourceId]/route.ts`,
  access: "course_teacher",
  summary:
    "The holder of the course adds a required source to it or changes one: {record, doi?, isbn?, undated?}, at most 64 KiB, as the student's source; the source id is chosen by the client and must equal record.id. A course holds at most 200 sources (422) and a DOI or an ISBN once (409 conflict). A teacher that is not the holder, a student and a course the caller does not teach answer 404.",
  request: {
    params: sourceOfCourseParams,
    contentType: "application/json",
    maxBodyBytes: 65536,
    body: SourceInput,
  },
  responses: [{ status: 200, description: "the saved source", body: CourseSource }],
  errors: [...WRITE_ERRORS, error(409, "conflict")],
});

export const teacherCourseLiteratureDelete = defineRoute({
  id: "teacher.course-literature.delete",
  method: "DELETE",
  path: `${COURSES}/{sourceId}`,
  inventory: `${COURSES_INV}/[sourceId]/route.ts`,
  access: "course_teacher",
  summary:
    "The holder of the course removes a required source from it; 204 also when there was none. A teacher that is not the holder, a student and a course the caller does not teach answer 404.",
  request: { params: sourceOfCourseParams },
  responses: [{ status: 204, description: "removed" }],
  errors: BODYLESS_WRITE_ERRORS,
});

export const studentCourseLiteratureGet = defineRoute({
  id: "student.course-literature.get",
  method: "GET",
  path: "/api/v1/student/courses/{courseId}/required-literature",
  inventory: "app/api/student/courses/[courseId]/required-literature/route.ts",
  access: "student_enrolled",
  summary:
    "The required literature of a course the caller is a student of, oldest first then by id. A course the caller is not a student of, an unknown and a malformed id answer 404.",
  request: { params: courseParams },
  responses: [
    {
      status: 200,
      description: "the required literature, possibly empty",
      body: closed({ sources: Type.Array(CourseSource, { maxItems: 200 }) }),
      headers: ["cache-control"],
    },
  ],
  errors: READ_ERRORS,
});

export const studentSourceProofRequestsGet = defineRoute({
  id: "student.source-proof-requests.get",
  method: "GET",
  path: "/api/v1/student/assignments/{assignmentId}/source-proof-requests",
  inventory: "app/api/student/assignments/[assignmentId]/source-proof-requests/route.ts",
  access: "student_enrolled",
  summary:
    "The requests for a proof of a source of the caller's own work, oldest first (open and closed). The student answers a request by attaching a proof to the source (student.source-proofs.post). Another student's work, an unknown and a malformed assignment id answer 404.",
  request: { params: closed({ assignmentId: Type.String({ minLength: 1 }) }) },
  responses: [
    {
      status: 200,
      description: "the requests, possibly empty",
      body: closed({ proofRequests: Type.Array(ProofRequest, { maxItems: 1000 }) }),
      headers: ["cache-control"],
    },
  ],
  errors: READ_ERRORS,
});

export const teacherSourcesRoutes = [
  teacherSourceGuidanceGet,
  teacherSourceRecommendationPut,
  teacherSourceRecommendationDelete,
  teacherSourceProofRequestPut,
  teacherSourceProofRequestDelete,
  teacherLiteratureSeenPut,
  teacherSourceProofsGet,
  teacherSourceProofImageGet,
  teacherCourseLiteratureGet,
  teacherCourseLiteraturePut,
  teacherCourseLiteratureDelete,
  studentCourseLiteratureGet,
  studentSourceProofRequestsGet,
] as const;

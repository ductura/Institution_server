import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

import { MUTATION_GUARD } from "./shared.ts";
import { CODE_POINT, END } from "./teacher.ts";

// SRV-1102 (Ductus#2051, wave 11, editor E§3.4 "proofs", B-8): the proofs of a
// source, the excerpts a student attaches to a source of the own work (a
// photo, a pasted image or a crop from a PDF that never leaves the browser).
// The table and the RPCs are institution.source_proof (migration
// 20261121130000). Only an excerpt is kept: the image must be a JPEG, so a
// whole PDF is refused. A proof is "attached by the student"; Ductura does not
// claim the source says what the student writes. Not evidence: outside the
// document and its hash.

/** A lowercase UUID, as PostgreSQL writes uuid. */
const LowerUuid = Type.String({
  pattern: `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}${END}`,
});

/** 1 to `max` code points, no control character (a note may hold \n), no white space at either end. */
const ProofText = (max: number, lines: boolean) =>
  Type.String({
    pattern: `^(?!\\s)(?:${CODE_POINT}|${lines ? "\\n|" : ""}[^\\u0000-\\u001f\\u007f-\\u009f\\uD800-\\uDFFF]){1,${max}}(?<!\\s)${END}`,
  });
/** The page of the source the excerpt shows ("14", "xii", "14-15"). */
export const Page = ProofText(30, false);
export const Note = ProofText(2000, true);

const PATH = "/api/v1/student/assignments/{assignmentId}/sources/{sourceId}/proofs";
const INVENTORY = "app/api/student/assignments/[assignmentId]/sources/[sourceId]/proofs";

/** One proof as the student reads it; imagePath is the GET of its JPEG bytes. */
export const SourceProof = closed({
  id: LowerUuid,
  page: Page,
  note: Type.Union([Note, Type.Null()]),
  imagePath: Type.String({
    pattern: `^/api/v1/student/assignments/[0-9a-f-]{36}/sources/[0-9a-f-]{36}/proofs/[0-9a-f-]{36}/image${END}`,
  }),
});

const proofsParams = closed({
  assignmentId: Type.String({ minLength: 1 }),
  sourceId: Type.String({ minLength: 1 }),
});
const READ_ERRORS = [
  error(401, "unauthorized"),
  error(404, "not_found"),
  error(503, "unavailable"),
] as const;

export const studentSourceProofsGet = defineRoute({
  id: "student.source-proofs.get",
  method: "GET",
  path: PATH,
  inventory: `${INVENTORY}/route.ts`,
  access: "student_enrolled",
  summary:
    "The proofs (attached excerpts) of one source of the caller's own work, oldest first, then by id. Another student's work, a source that is not in the work, an unknown or a malformed id return 404.",
  request: { params: proofsParams },
  responses: [
    {
      status: 200,
      description: "proofs, possibly empty",
      body: closed({ proofs: Type.Array(SourceProof, { maxItems: 200 }) }),
    },
  ],
  errors: READ_ERRORS,
});

export const studentSourceProofsPost = defineRoute({
  id: "student.source-proofs.post",
  method: "POST",
  path: PATH,
  inventory: `${INVENTORY}/route.ts`,
  access: "student_enrolled",
  summary:
    "Attaches an excerpt to a source of the caller's own work: a multipart form with the JPEG image (at most 1 MiB), the page and an optional note. Only an excerpt is kept: a whole PDF or any other file that is not a JPEG returns 422, as does a work at its bound (200 proofs or 100 MiB). Another student's work or a source that is not in the work returns 404.",
  request: {
    params: proofsParams,
    contentType: "multipart/form-data",
    maxBodyBytes: 1_114_112,
    body: closed({
      /** The JPEG bytes of the excerpt (a file part); a vector writes them in Base64. */
      image: Type.String({ minLength: 1, contentMediaType: "image/jpeg" }),
      page: Page,
      note: Type.Optional(Note),
    }),
  },
  responses: [{ status: 201, description: "the attached proof", body: SourceProof }],
  errors: [
    ...MUTATION_GUARD,
    ...READ_ERRORS,
    error(415, "unsupported_media_type"),
    error(422, "invalid_input"),
  ],
});

export const studentSourceProofImageGet = defineRoute({
  id: "student.source-proof-image.get",
  method: "GET",
  path: `${PATH}/{proofId}/image`,
  inventory: `${INVENTORY}/[proofId]/image/route.ts`,
  access: "student_enrolled",
  summary:
    "The JPEG bytes of one proof of a source of the caller's own work. The proof is named by its work, source and id together; another student's work, another source or an unknown or malformed id return 404.",
  request: {
    params: closed({ ...proofsParams.properties, proofId: Type.String({ minLength: 1 }) }),
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

export const sourceProofsRoutes = [
  studentSourceProofsGet,
  studentSourceProofsPost,
  studentSourceProofImageGet,
] as const;

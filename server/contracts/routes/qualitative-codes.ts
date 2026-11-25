// SRV-V18-KODIRANJE-SIFRARNIK (Ductus#2058, order c.7173077456; val 18, WEB
// docs/nalazi/val18-razlika.md §5 task 7): the codebook of a student's
// qualitative coding. The codes are the student's own and nobody else's: the
// teacher and the mentor read none (V18-9, OP-V18-5), another's, an unknown and a
// malformed id are the same 404 (C-23). The answer is in the order of the
// codebook, the owner's order, never by how often a code is used (V18-8). Nothing
// here suggests a code or calls an assistant (V18-3). The text is in
// docs/contracts/qualitative-codes-v1.md.
import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

import { MUTATION_GUARD } from "./shared.ts";
import { CODE_POINT, END } from "./teacher.ts";

const Uuid = `[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}`;
const Id = Type.String({ pattern: `^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}${END}` });
/** A path id: the same shape, either case; a malformed one is the same 404. */
const IdParam = Type.String({ pattern: `^${Uuid}${END}` });

/** The most codes one student keeps (the database refuses the 201st with a conflict). */
export const QUAL_CODES_MAX = 200;
export const QUAL_CODE_NAME_MAX = 80;
export const QUAL_CODE_DESCRIPTION_MAX = 500;

const oneLine = (max: number) =>
  `(?!\\s)(?:${CODE_POINT}|[^\\u0000-\\u001f\\u007f-\\u009f\\uD800-\\uDFFF]){1,${max}}(?<!\\s)`;
/** A name: one line of 1 to 80 code points, not padded. */
const CodeName = Type.String({ pattern: `^${oneLine(QUAL_CODE_NAME_MAX)}${END}` });
/** A description: no text is the empty string, else one line of 1 to 500 code points. */
const CodeDescription = Type.String({
  pattern: `^(?:|${oneLine(QUAL_CODE_DESCRIPTION_MAX)})${END}`,
});

export const QualCode = closed({
  id: Id,
  name: CodeName,
  description: CodeDescription,
  /** The place in the codebook, 1 = first, numbered without gaps. */
  order: Type.Integer({ minimum: 1, maximum: QUAL_CODES_MAX }),
});
const QualCodes = closed({ codes: Type.Array(QualCode, { maxItems: QUAL_CODES_MAX }) });

const CodeParams = closed({ id: IdParam });
const noStore = ["cache-control"];
const readErrors = [error(401, "unauthorized"), error(503, "unavailable")] as const;
const idErrors = [...readErrors, error(404, "not_found")] as const;
const invalidInput = error(422, "invalid_input");
const conflict = error(409, "conflict");
const writeErrors = [
  ...MUTATION_GUARD,
  ...idErrors,
  error(415, "unsupported_media_type"),
  error(400, "invalid_json"),
  invalidInput,
] as const;

const collection = {
  path: "/api/v1/student/qual/codes",
  inventory: "app/api/student/qual/codes/route.ts",
  access: "student",
} as const;
const member = {
  path: "/api/v1/student/qual/codes/{id}",
  inventory: "app/api/student/qual/codes/[id]/route.ts",
  access: "student",
} as const;

export const studentQualCodesGet = defineRoute({
  ...collection,
  id: "student.qual-codes.get",
  method: "GET",
  summary:
    "The caller's own codebook for qualitative coding, in its own order (order 1 first), never by use. Possibly empty. Only the owner reads it: a teacher, a mentor and another student see nothing of it.",
  request: {},
  responses: [
    {
      status: 200,
      description: "the codebook, in the owner's order",
      body: QualCodes,
      headers: noStore,
    },
  ],
  errors: readErrors,
});

export const studentQualCodesPost = defineRoute({
  ...collection,
  id: "student.qual-codes.post",
  method: "POST",
  summary:
    "Adds a code to the end of the caller's codebook: name (one line, 1 to 80 code points) and an optional description (one line, up to 500; none is empty). A name the codebook already has, the case aside, and the 201st code are 409 conflict. The answer is the code with its place. Nothing here proposes a code.",
  request: {
    body: closed({ name: CodeName, description: Type.Optional(CodeDescription) }),
    contentType: "application/json",
    maxBodyBytes: 4096,
  },
  responses: [{ status: 201, description: "the created code", body: QualCode, headers: noStore }],
  errors: [
    ...MUTATION_GUARD,
    ...readErrors,
    error(415, "unsupported_media_type"),
    error(400, "invalid_json"),
    invalidInput,
    conflict,
  ],
});

export const studentQualCodePatch = defineRoute({
  ...member,
  id: "student.qual-code.patch",
  method: "PATCH",
  summary:
    "Renames, re-describes or moves a code of the caller's codebook: any of name, description and order (the place, 1 = first; the others keep their order), at least one. A place outside 1 to the number of codes is 422 invalid_input; a name another code has, the case aside, is 409 conflict. Another's, an unknown and a malformed code read 404. The answer is the code as it now is.",
  request: {
    params: CodeParams,
    body: closed({
      name: Type.Optional(CodeName),
      description: Type.Optional(CodeDescription),
      order: Type.Optional(Type.Integer({ minimum: 1, maximum: QUAL_CODES_MAX })),
    }),
    contentType: "application/json",
    maxBodyBytes: 4096,
  },
  responses: [{ status: 200, description: "the code", body: QualCode, headers: noStore }],
  errors: [...writeErrors, conflict],
});

export const studentQualCodeDelete = defineRoute({
  ...member,
  id: "student.qual-code.delete",
  method: "DELETE",
  summary:
    "Deletes a code of the caller's codebook; the others close up. A code with marked passages is deleted together with them only when the query says confirm=true; without it that is 409 conflict and nothing is removed. A code without passages needs no confirmation. Another's, an unknown and a malformed code read 404.",
  request: {
    params: CodeParams,
    query: closed({ confirm: Type.Optional(Type.Literal("true")) }),
  },
  responses: [{ status: 204, description: "removed" }],
  errors: [...MUTATION_GUARD, ...idErrors, invalidInput, conflict],
});

export const qualitativeCodesRoutes = [
  studentQualCodesGet,
  studentQualCodesPost,
  studentQualCodePatch,
  studentQualCodeDelete,
] as const;

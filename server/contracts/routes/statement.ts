import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error, problemFields, REQUEST_ID_PATTERN } from "../schema/index.ts";
import { MUTATION_GUARD } from "./shared.ts";

const SHA256 = Type.String({ pattern: "^[0-9a-f]{64}$" });
const ID = Type.String({ pattern: REQUEST_ID_PATTERN });
const Version = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const DraftVersion = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const Use = Type.Union([Type.Literal("used"), Type.Literal("not_used")]);
const Format = Type.Union([Type.Literal("application/pdf"), Type.Literal("text/plain")]);
const Form = closed({
  formId: Type.String({ pattern: "^[a-z0-9][a-z0-9-]{0,63}$" }),
  formVersion: Type.Integer({ minimum: 1, maximum: 2147483647 }),
  formSha256: SHA256,
});
const HumanHelp = closed({
  received: Type.Boolean(),
  entries: Type.Array(
    closed({
      kind: Type.Union(
        ["language", "structure", "sources", "content", "technical", "other"].map((kind) =>
          Type.Literal(kind),
        ),
      ),
      text: Type.String({
        minLength: 1,
        maxLength: 4000,
        description: "Up to 2000 Unicode code points.",
      }),
    }),
    { maxItems: 20 },
  ),
});
const Tools = Type.Array(
  closed({
    toolLabel: Type.String({
      minLength: 1,
      maxLength: 400,
      description: "Up to 200 Unicode code points.",
    }),
    purposeText: Type.String({
      minLength: 1,
      maxLength: 400,
      description: "Up to 200 Unicode code points.",
    }),
    phaseText: Type.String({
      minLength: 1,
      maxLength: 400,
      description: "Up to 200 Unicode code points.",
    }),
  }),
  { maxItems: 20 },
);
const OwnWork = closed({ confirmed: Type.Boolean() });
// SRV-IZJAVA-PITANJE (declaration-v1 section 6.8): the teacher's optional
// question and the student's optional answer. The answer is no part of the
// hashed payload; it is bound to the saved row (draft or version) and is
// stale or bound exactly as that row is.
const QuestionId = Type.String({
  pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
});
const QuestionText = Type.String({
  minLength: 1,
  maxLength: 1000,
  description: "Up to 500 Unicode code points.",
});
const AnswerText = Type.String({
  minLength: 1,
  maxLength: 4000,
  description:
    "Up to 2000 Unicode code points, NFC, no leading or trailing space, no control character but the line feed.",
});
const TeacherQuestion = Type.Union([
  closed({ questionId: QuestionId, text: QuestionText }),
  Type.Null(),
]);
const QuestionAnswer = Type.Union([
  closed({ questionId: QuestionId, questionText: QuestionText, text: AnswerText }),
  Type.Null(),
]);
const PutAnswer = Type.Union([closed({ questionId: QuestionId, text: AnswerText }), Type.Null()]);
// F4-PRE-R02-SRV2 (R-35): why the chosen pattern of use differs from the
// record of transfers. Not part of the hashed payload (declaration-v1 6.9).
const MismatchExplanation = Type.Union([AnswerText, Type.Null()]);
const Put = closed({
  baseVersion: DraftVersion,
  revision: Version,
  form: Form,
  ownWork: OwnWork,
  humanHelp: HumanHelp,
  ai: closed({
    use: Type.Union([Use, Type.Null()]),
    declaredTools: Tools,
    attachments: Type.Array(
      closed({ conversationId: ID, throughSeq: Version, messagesSha256: SHA256 }),
      { maxItems: 0 },
    ),
    externalAttachmentIds: Type.Array(ID, { maxItems: 10 }),
  }),
  confirm: Type.Boolean(),
});
// The request generator supports one object level and no nested item validators.
// The HTTP edge runs the closed declaration parser on the full input.
const PutRequest = closed({
  ...Put.properties,
  humanHelp: Type.Object(
    { received: Type.Boolean() },
    {
      description: "Closed declaration-v1 object with received and entries [{kind,text}].",
    },
  ),
  ai: Type.Object(
    { use: Type.Union([Use, Type.Null()]) },
    {
      description:
        "Closed declaration-v1 object with use, declaredTools, empty attachments, and externalAttachmentIds.",
    },
  ),
  // SRV-IZJAVA-PITANJE: the answer to the question the student read (its
  // questionId from teacherQuestion). Omitted or null: no answer.
  questionAnswer: Type.Optional(PutAnswer),
});
const Attachment = closed({
  externalAttachmentId: ID,
  format: Format,
  byteLength: Type.Integer({ minimum: 1, maximum: 2097152 }),
  contentSha256: SHA256,
});
const Payload = closed({
  declarationSchema: Type.Literal("ductura-declaration-v1"),
  declarationId: ID,
  declarationVersion: Version,
  principalId: ID,
  assignmentId: ID,
  assignmentVersion: Version,
  documentId: Type.String({ minLength: 1, maxLength: 256 }),
  revision: Version,
  form: Form,
  ownWork: closed({ confirmed: Type.Literal(true) }),
  humanHelp: HumanHelp,
  ai: closed({
    use: Use,
    declaredTools: Tools,
    recorded: Type.Array(closed({ aiTransferId: ID, aiTransferSha256: SHA256 }), { maxItems: 0 }),
    attachments: Type.Array(
      closed({ ...Attachment.properties, reason: Type.Literal("external_upload") }),
      { maxItems: 10 },
    ),
  }),
  confirmedAt: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{6}Z$" }),
});
// TypeBox's runtime checker counts UTF-16 units. The domain and the database
// enforce the tighter limit in Unicode code points.
const FormText = Type.String({
  minLength: 1,
  maxLength: 40000,
  description: "Up to 20000 Unicode code points.",
});
const Statement = closed({
  state: Type.Union(
    ["none", "draft", "confirmed", "stale", "bound"].map((state) => Type.Literal(state)),
  ),
  submitted: Type.Boolean(),
  currentRevision: Type.Union([DraftVersion, Type.Null()]),
  version: DraftVersion,
  formText: Type.Union([FormText, Type.Null()]),
  currentForm: Type.Union([closed({ ...Form.properties, text: FormText }), Type.Null()]),
  draft: Type.Union([Put, Type.Null()]),
  payload: Type.Union([Payload, Type.Null()]),
  declarationSha256: Type.Union([SHA256, Type.Null()]),
  uploads: Type.Array(Attachment, { maxItems: 10 }),
  // PIL-K-IZJAVA-SRV: whether a submission of this assignment requires a
  // declaration confirmed for the submitted revision. Always sent; optional
  // only so older clients keep validating.
  declarationRequired: Type.Optional(Type.Boolean()),
  // SRV-IZJAVA-PITANJE: the question in force (null: none) and the answer of
  // the row the state is about (null: none). Always sent; optional only so
  // older clients keep validating.
  teacherQuestion: Type.Optional(TeacherQuestion),
  questionAnswer: Type.Optional(QuestionAnswer),
  // F4-PRE-R02-SRV2 (R-35): the student's explanation of the row the state is
  // about (null: none). Always sent; optional only so older clients keep validating.
  mismatchExplanation: Type.Optional(MismatchExplanation),
});
// F4-PRE-R02-SRV, F4-PRE-R06-SRV: declaration-v2 bodies. The v1 routes keep
// their empty attachments and recorded lists; the v2 routes carry the
// conversations with the Asistent a declaration attaches (declaration-v1
// sections 2.1 and 2.2) and the recorded transfers. The PUT parser takes up to
// ten times the student_added limit (MAX_PUT_CONVERSATIONS); the save RPC
// refuses more than fifty student_added ones and names a missing mandatory one
// (mandatory_attachment_missing) or a stale one (attachment_stale).
const MAX_CONVERSATION_REFS = 500;
const ConversationRef = closed({ conversationId: ID, throughSeq: Version, messagesSha256: SHA256 });
const ConversationReason = Type.Union(
  ["transferred_deleted", "transferred", "pasted_known", "student_added"].map((reason) =>
    Type.Literal(reason),
  ),
);
const PutV2 = closed({
  ...Put.properties,
  ai: closed({
    ...Put.properties.ai.properties,
    attachments: Type.Array(ConversationRef, { maxItems: MAX_CONVERSATION_REFS }),
  }),
});
const PutRequestV2 = closed({
  ...PutRequest.properties,
  ai: Type.Object(
    { use: Type.Union([Use, Type.Null()]) },
    {
      description:
        "Closed declaration-v1 object with use, declaredTools, attachments [{conversationId,throughSeq,messagesSha256}] (up to 500) and externalAttachmentIds.",
    },
  ),
  // F4-PRE-R02-SRV2 (R-35): the student's explanation of a pattern of use the
  // record of transfers contradicts. Omitted or null: none.
  mismatchExplanation: Type.Optional(MismatchExplanation),
});
const PayloadV2 = closed({
  ...Payload.properties,
  ai: closed({
    ...Payload.properties.ai.properties,
    recorded: Type.Array(closed({ aiTransferId: ID, aiTransferSha256: SHA256 }), {
      maxItems: MAX_CONVERSATION_REFS,
    }),
    // The attached conversations come first, by reason in table order and
    // then by id; external uploads last.
    attachments: Type.Array(
      Type.Union([
        closed({ ...ConversationRef.properties, reason: ConversationReason }),
        closed({ ...Attachment.properties, reason: Type.Literal("external_upload") }),
      ]),
      { maxItems: MAX_CONVERSATION_REFS + 10 },
    ),
  }),
});
const StatementV2 = closed({
  ...Statement.properties,
  draft: Type.Union([PutV2, Type.Null()]),
  payload: Type.Union([PayloadV2, Type.Null()]),
});
// AI-RECORDED-5000: a work holds up to 5000 transfers
// (assistant.ai_transfer_max()), so ai.recorded can list as many. The v2
// bodies stay at 500, since raising them would break their clients; the
// declaration-v3 routes carry the same body with recorded up to 5000. A v2
// route whose declaration lists more answers 503 unavailable.
export const MAX_RECORDED_TRANSFERS = 5000;
const PayloadV3 = closed({
  ...PayloadV2.properties,
  ai: closed({
    ...PayloadV2.properties.ai.properties,
    recorded: Type.Array(closed({ aiTransferId: ID, aiTransferSha256: SHA256 }), {
      maxItems: MAX_RECORDED_TRANSFERS,
    }),
  }),
});
const StatementV3 = closed({
  ...StatementV2.properties,
  payload: Type.Union([PayloadV3, Type.Null()]),
});
const Params = closed({ assignmentId: Type.String({ minLength: 1 }) });
const READ_ERRORS = [
  error(401, "unauthorized"),
  error(403, "forbidden"),
  error(404, "not_found"),
  error(503, "unavailable"),
];
const WRITE_ERRORS = [
  ...MUTATION_GUARD,
  error(401, "unauthorized"),
  error(404, "not_found"),
  error(409, "conflict"),
  error(422, "invalid_input"),
  error(503, "unavailable"),
];
/** A 409 whose problem body also names what the client must reload or attach. */
function conflictWith(code: string, fields: Parameters<typeof closed>[0]) {
  return error(
    409,
    code,
    closed({ error: Type.Literal(code), ...problemFields(code, 409), ...fields }),
  );
}
const ConversationIds = Type.Array(ID, { minItems: 1, maxItems: 20 });
// declaration-v1 §7.3: the reasons the save RPC gives for refusing a declaration.
const SAVE_ERRORS = [
  ...WRITE_ERRORS,
  error(400, "invalid_json"),
  error(415, "unsupported_media_type"),
  error(422, "invalid_attachment"),
  error(409, "already_submitted"),
  error(409, "form_outdated"),
  error(409, "incomplete"),
  conflictWith("declaration_conflict", { currentVersion: DraftVersion }),
  conflictWith("stale_revision", { currentRevision: Version }),
  conflictWith("mandatory_attachment_missing", { conversationIds: ConversationIds }),
  conflictWith("attachment_stale", { conversationIds: ConversationIds }),
];
const UPLOAD_ERRORS = [
  ...WRITE_ERRORS,
  error(415, "unsupported_media_type"),
  error(409, "already_submitted"),
  error(409, "too_many_attachments"),
  error(409, "attachments_too_large"),
];
const INVENTORY = "app/api/student/assignments/[assignmentId]";
const URL = "/api/v1/student/assignments/{assignmentId}";
export const STATEMENT_MAX_BODY_BYTES = (20 * 2000 + 20 * 3 * 200) * 12 + 16 * 1024;
// Each conversation reference is plain ASCII, at most 192 bytes.
export const STATEMENT_V2_MAX_BODY_BYTES = STATEMENT_MAX_BODY_BYTES + MAX_CONVERSATION_REFS * 192;

export const studentDeclarationGet = defineRoute({
  id: "student.declaration.get",
  method: "GET",
  path: `${URL}/declaration`,
  inventory: `${INVENTORY}/declaration/route.ts`,
  access: "student_enrolled",
  summary:
    "Read the student's declaration, the current faculty form when configured, and the metadata of external uploads.",
  request: { params: Params },
  responses: [
    { status: 200, body: Statement, description: "Declaration state", headers: ["cache-control"] },
  ],
  errors: READ_ERRORS,
});
export const studentDeclarationPut = defineRoute({
  id: "student.declaration.put",
  method: "PUT",
  path: `${URL}/declaration`,
  inventory: `${INVENTORY}/declaration/route.ts`,
  access: "student_enrolled",
  summary:
    "Save a draft or confirm an immutable declaration for the current document revision. A stale base, unconfirmed fields, an outdated form or a submission request returns 409.",
  request: {
    params: Params,
    contentType: "application/json",
    maxBodyBytes: STATEMENT_MAX_BODY_BYTES,
    body: PutRequest,
  },
  responses: studentDeclarationGet.responses,
  errors: SAVE_ERRORS,
});
export const studentDeclarationAttachmentsPost = defineRoute({
  id: "student.declaration-attachments.post",
  method: "POST",
  path: `${URL}/declaration-attachments`,
  inventory: `${INVENTORY}/declaration-attachments/route.ts`,
  access: "student_enrolled",
  summary:
    "Send raw PDF or UTF-8 plain-text bytes with Content-Type application/pdf or text/plain. Other media types yield 415; bytes that do not match the type yield 422. Uploading returns a reference for a later declaration PUT.",
  request: { params: Params, maxBodyBytes: 2097152 },
  responses: [
    {
      status: 200,
      body: Attachment,
      description: "External attachment reference",
      headers: ["cache-control"],
    },
  ],
  errors: UPLOAD_ERRORS,
});
export const studentDeclarationConversationsGet = defineRoute({
  id: "student.declaration-conversations.get",
  method: "GET",
  path: `${URL}/declaration-conversations`,
  inventory: `${INVENTORY}/declaration-conversations/route.ts`,
  access: "student_enrolled",
  summary:
    "List the student's own assistant conversations of this assignment that a declaration can attach, each with the throughSeq and messagesSha256 of a reference. Send them with student.declaration-second.put. Only conversations with a message; never another student's.",
  request: { params: Params },
  responses: [
    {
      status: 200,
      body: closed({
        conversations: Type.Array(
          closed({
            conversationId: ID,
            reason: ConversationReason,
            throughSeq: Version,
            messagesSha256: SHA256,
          }),
          { maxItems: 200 },
        ),
      }),
      description: "Attachable conversations",
      headers: ["cache-control"],
    },
  ],
  errors: READ_ERRORS,
});
export const studentDeclarationV2Get = defineRoute({
  id: "student.declaration-second.get",
  method: "GET",
  path: `${URL}/declaration-v2`,
  inventory: `${INVENTORY}/declaration-v2/route.ts`,
  access: "student_enrolled",
  summary:
    "Read the student's declaration as student.declaration.get does, with the attached conversations and the recorded transfers of declaration-v2 bodies.",
  request: { params: Params },
  responses: [
    {
      status: 200,
      body: StatementV2,
      description: "Declaration state",
      headers: ["cache-control"],
    },
  ],
  errors: READ_ERRORS,
});
export const studentDeclarationV2Put = defineRoute({
  id: "student.declaration-second.put",
  method: "PUT",
  path: `${URL}/declaration-v2`,
  inventory: `${INVENTORY}/declaration-v2/route.ts`,
  access: "student_enrolled",
  summary:
    "Save a draft or confirm a declaration as student.declaration.put does, attaching up to 500 conversation references. A missing mandatory or stale conversation returns 409 with its conversationIds.",
  request: {
    params: Params,
    contentType: "application/json",
    maxBodyBytes: STATEMENT_V2_MAX_BODY_BYTES,
    body: PutRequestV2,
  },
  responses: studentDeclarationV2Get.responses,
  errors: SAVE_ERRORS,
});
export const studentDeclarationV3Get = defineRoute({
  id: "student.declaration-third.get",
  method: "GET",
  path: `${URL}/declaration-v3`,
  inventory: `${INVENTORY}/declaration-v3/route.ts`,
  access: "student_enrolled",
  summary:
    "Read the student's declaration as student.declaration-second.get does, with up to 5000 recorded transfers; student.declaration-second.get answers 503 unavailable for a declaration that records more than 500.",
  request: { params: Params },
  responses: [
    {
      status: 200,
      body: StatementV3,
      description: "Declaration state",
      headers: ["cache-control"],
    },
  ],
  errors: READ_ERRORS,
});
export const studentDeclarationV3Put = defineRoute({
  id: "student.declaration-third.put",
  method: "PUT",
  path: `${URL}/declaration-v3`,
  inventory: `${INVENTORY}/declaration-v3/route.ts`,
  access: "student_enrolled",
  summary:
    "Save a draft or confirm a declaration as student.declaration-second.put does, answering with up to 5000 recorded transfers; student.declaration-second.put saves such a declaration but answers 503 unavailable.",
  request: {
    params: Params,
    contentType: "application/json",
    maxBodyBytes: STATEMENT_V2_MAX_BODY_BYTES,
    body: PutRequestV2,
  },
  responses: studentDeclarationV3Get.responses,
  errors: SAVE_ERRORS,
});
export const statementRoutes = [
  studentDeclarationGet,
  studentDeclarationConversationsGet,
  studentDeclarationPut,
  studentDeclarationAttachmentsPost,
  studentDeclarationV2Get,
  studentDeclarationV2Put,
  studentDeclarationV3Get,
  studentDeclarationV3Put,
] as const;

// The confirmed declaration payload, shared with the teacher's read (SRV-1213).
export { Payload as DeclarationPayload, SHA256 as DeclarationSha256 };
export { PayloadV2 as DeclarationPayloadV2, PayloadV3 as DeclarationPayloadV3 };
export {
  QuestionAnswer as DeclarationQuestionAnswer,
  TeacherQuestion as DeclarationTeacherQuestion,
};

// SRV-V16-TEMA-PRIJEDLOG (val16-razlika, Ductus#2058): the student owner of a
// thesis proposes the topic (a title and a short description) and the mentor
// approves it or returns it with a comment. A version per proposal, a decision
// per version, both only ever added. None of it enters a grade and none of it
// changes the faculty form "prijava-teme" (separate, see thesis.ts). Access is
// decided by the database (app.* RPCs in 20261220110000_thesis_topic.sql): the
// student owner, the mentor of the work and the administrator of its
// institution read; only the student proposes, only the mentor decides.
import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

import { MUTATION_GUARD } from "./shared.ts";
import { CODE_POINT, END } from "./teacher.ts";

const DocumentId = Type.String({
  pattern: `^(?!\\s)(?:${CODE_POINT}|[^\\u0000-\\u001f\\u007f-\\u009f\\uD800-\\uDFFF]){1,256}(?<!\\s)${END}`,
});
const Instant = Type.String({
  pattern: `^\\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])T(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d{1,3})?(?:Z|[+-](?:[01]\\d|2[0-3]):[0-5]\\d)${END}`,
});
const Version = Type.Integer({ minimum: 1, maximum: 100 });
/** One line a person wrote: 1 to 200 characters, no control character; the database also asks for NFC. */
export const TopicTitle = Type.String({
  pattern: `^(?=[\\s\\S]*[^ \\t\\r\\n])(?:${CODE_POINT}|[^\\u0000-\\u001f\\u007f-\\u009f\\uD800-\\uDFFF]){1,200}${END}`,
});
/** A short description: 0 to 1000 characters, newline and tab allowed, no other control character. */
export const TopicSummary = Type.String({
  pattern: `^(?:${CODE_POINT}|[^\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f\\uD800-\\uDFFF]){0,1000}${END}`,
});
/** The mentor's comment: 1 to 1000 characters, newline and tab allowed. */
export const TopicComment = Type.String({
  pattern: `^(?=[\\s\\S]*[^ \\t\\r\\n])(?:${CODE_POINT}|[^\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f\\uD800-\\uDFFF]){1,1000}${END}`,
});
export const THESIS_TOPIC_STATES = ["none", "proposed", "approved", "returned"] as const;
export const THESIS_TOPIC_DECISIONS = ["approved", "returned"] as const;

const TopicVersion = closed({
  version: Version,
  title: TopicTitle,
  summary: TopicSummary,
  proposedAt: Instant,
});
const TopicDecision = closed({
  version: Version,
  decision: Type.Union(THESIS_TOPIC_DECISIONS.map((decision) => Type.Literal(decision))),
  comment: Type.Union([TopicComment, Type.Null()]),
  decidedAt: Instant,
  decidedByPart: Type.Literal("mentor"),
});
const ThesisTopic = closed({
  state: Type.Union(THESIS_TOPIC_STATES.map((state) => Type.Literal(state))),
  /** The newest proposal; null while there is none. */
  current: Type.Union([TopicVersion, Type.Null()]),
  /** The decision on the newest proposal; null while it has none (a new proposal starts without one). */
  decision: Type.Union([TopicDecision, Type.Null()]),
  /** Every proposal, oldest first (at most 100 versions). */
  history: Type.Array(TopicVersion, { maxItems: 100 }),
});
export const ThesisTopicInput = closed({
  title: TopicTitle,
  summary: Type.Optional(TopicSummary),
});
export const ThesisTopicDecisionInput = closed({
  version: Version,
  decision: Type.Union(THESIS_TOPIC_DECISIONS.map((decision) => Type.Literal(decision))),
  comment: Type.Optional(TopicComment),
});

const readErrors = [error(401, "unauthorized"), error(404, "not_found"), error(503, "unavailable")];
const writeErrors = [
  ...MUTATION_GUARD,
  ...readErrors,
  error(400, "invalid_json"),
  error(403, "forbidden"),
  error(409, "conflict"),
  error(415, "unsupported_media_type"),
  error(422, "invalid_input"),
];
const noStore = ["cache-control"];
const work = closed({ documentId: DocumentId });

export const workThesisTopicGet = defineRoute({
  id: "work.thesis-topic.get",
  method: "GET",
  path: "/api/v1/works/{documentId}/thesis-topic",
  inventory: "app/api/works/[documentId]/thesis-topic/route.ts",
  access: "owner_or_mentor",
  summary:
    "The topic of this thesis as the student proposed it and the mentor decided: the state (none, proposed, approved, returned), the newest proposal, the decision on it and every proposal in order. For the student owner, the mentor and the administrator of the faculty; anyone else, another faculty and a work that is not a mentored thesis read 404.",
  request: { params: work },
  responses: [
    { status: 200, description: "The topic in force", body: ThesisTopic, headers: noStore },
  ],
  errors: readErrors,
});

export const workThesisTopicPut = defineRoute({
  id: "work.thesis-topic.put",
  method: "PUT",
  path: "/api/v1/works/{documentId}/thesis-topic",
  inventory: "app/api/works/[documentId]/thesis-topic/route.ts",
  access: "student_owner",
  summary:
    "The student owner proposes the topic: a new version with the title (1 to 200 characters) and an optional description (up to 1000). The content of the newest version writes nothing. After approval it is 409, as is the 101st version. The mentor and the administrator are 403.",
  request: {
    params: work,
    body: ThesisTopicInput,
    contentType: "application/json",
    maxBodyBytes: 8192,
  },
  responses: [
    { status: 200, description: "The topic in force", body: ThesisTopic, headers: noStore },
  ],
  errors: writeErrors,
});

export const workThesisTopicDecisionPost = defineRoute({
  id: "work.thesis-topic-decision.post",
  method: "POST",
  path: "/api/v1/works/{documentId}/thesis-topic/decision",
  inventory: "app/api/works/[documentId]/thesis-topic/decision/route.ts",
  access: "mentor_teacher",
  summary:
    "The mentor approves the topic or returns it with a comment; the comment is required to return it. `version` must be the newest one (409 otherwise). A returned version takes no further decision (the student proposes again); an approved one can only be returned, with a reason. The student and the administrator are 403.",
  request: {
    params: work,
    body: ThesisTopicDecisionInput,
    contentType: "application/json",
    maxBodyBytes: 4096,
  },
  responses: [
    { status: 200, description: "The topic in force", body: ThesisTopic, headers: noStore },
  ],
  errors: writeErrors,
});

export const thesisTopicRoutes = [
  workThesisTopicGet,
  workThesisTopicPut,
  workThesisTopicDecisionPost,
] as const;

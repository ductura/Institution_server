import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

import { WorkId } from "./collaboration.ts";
import { MUTATION_GUARD } from "./shared.ts";

// SRV-1230 (Ductus#2052; P-1, rule 13, C-6): the match of a segment of a work
// with an answer of the assistant of the same work, 8 or more words in a row.
// The comparison is deterministic (server/domain/assistant-match) and no model
// takes part. The student who owns the work sends a segment; each answer it
// matches is recorded as a finding (the segment reference, the answer's ids and
// the length of the run, never a text) and its conversation is attached to the
// declaration as transferred text (D-41). The student and the readers of the
// work read the same findings. The switch of the faculty (assistantMatchEnabled,
// on in the pilot) decides: while it is off nothing is computed, saved or
// returned. A finding says "podudara se s odgovorom pomoćnika", never that
// anything was copied, and it is not evidence of authorship. Database:
// app.assistant_match_responses, app.assistant_match_record,
// app.assistant_match_read (20261213100800).
//
// PIL-P1-PODUDARANJE-OBJASNJENJE-SRV (Ductus#2052; P-1, rule 13): the student
// who owns the work explains a finding once, in at most 2000 characters (NFC, no
// control character but newline and tab); the explanation is never rewritten.
// The student and the readers read it with the finding, null while there is
// none. While the switch is off nothing is written or read. Database:
// app.assistant_match_explain, app.assistant_match_explanations (20261214130000).

const Uuid = Type.String({
  pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
});
const Instant = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$" });
/** The reference of the segment in the work: 1 to 128 characters without a control character. */
export const SegmentRef = Type.String({ pattern: "^[^\\u0000-\\u001f\\u007f-\\u009f]{1,128}$" });
const Text = Type.String({ minLength: 1, maxLength: 40_000 });
const RunWords = Type.Integer({ minimum: 8, maximum: 100_000 });
/** The student's explanation of a finding: 1 to 2000 characters. */
export const ASSISTANT_MATCH_EXPLANATION_MAX = 2000;
const ExplanationText = Type.String({ minLength: 1, maxLength: ASSISTANT_MATCH_EXPLANATION_MAX });
const Explanation = closed({ text: ExplanationText, writtenAt: Instant });

const Found = closed({ messageId: Uuid, conversationId: Uuid, runWords: RunWords });
const Finding = closed({
  segmentRef: SegmentRef,
  conversationId: Uuid,
  messageId: Uuid,
  runWords: RunWords,
  recordedAt: Instant,
  attachedAt: Instant,
  /**
   * The student's explanation, null while there is none. Optional only so that
   * the answer stays readable for older clients; the server always sends it.
   */
  explanation: Type.Optional(Type.Union([Explanation, Type.Null()])),
});

export const assistantMatchGet = defineRoute({
  id: "work.assistant-match.get",
  method: "GET",
  path: "/api/v1/works/{documentId}/assistant-match",
  inventory: "app/api/works/[documentId]/assistant-match/route.ts",
  access: "owner_or_course_teacher",
  summary:
    "The segments of a work that match an answer of the assistant of the same work in 8 or more words in a row, oldest first: the segment reference, the ids of the conversation and of the answer and the length of the run, never a text. The same answer for the student who owns the work and for its readers. An empty list while the faculty's switch is off. It is not evidence of authorship. Another's, an unknown or a malformed work returns 404.",
  request: { params: closed({ documentId: WorkId }) },
  responses: [
    {
      status: 200,
      description: "the findings, possibly none",
      body: closed({ findings: Type.Array(Finding, { maxItems: 10_000 }) }),
    },
  ],
  errors: [error(401, "unauthorized"), error(404, "not_found"), error(503, "unavailable")],
});

export const assistantMatchPost = defineRoute({
  id: "work.assistant-match.post",
  method: "POST",
  path: "/api/v1/works/{documentId}/assistant-match",
  inventory: "app/api/works/[documentId]/assistant-match/route.ts",
  access: "student_owner",
  summary:
    "The student who owns the work sends a segment, exactly {segmentRef, text} (text 1 to 40000 characters), and it is compared with the answers of the assistant in the student's own conversations of the same assignment (8 or more words in a row, normalization of case, spacing and punctuation). Each answer that matches is recorded once as a finding and its conversation is attached as transferred text (D-41). Answers 200 with the matches (ids and the length of the run), possibly none; with the faculty's switch off, always none and nothing is saved. A body that is not exactly this is 422. Anyone but the owner of the work gets 404.",
  request: {
    params: closed({ documentId: WorkId }),
    contentType: "application/json",
    maxBodyBytes: 192 * 1024,
    body: closed({ segmentRef: SegmentRef, text: Text }),
  },
  responses: [
    {
      status: 200,
      description: "the matches of this segment, possibly none",
      body: closed({ matches: Type.Array(Found, { maxItems: 200 }) }),
    },
  ],
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

export const assistantMatchExplanationPost = defineRoute({
  id: "work.assistant-match-explanation.post",
  method: "POST",
  path: "/api/v1/works/{documentId}/assistant-match/explanation",
  inventory: "app/api/works/[documentId]/assistant-match/explanation/route.ts",
  access: "student_owner",
  summary:
    "The student who owns the work explains one finding of the match with the assistant, exactly {segmentRef, messageId, text}: the text 1 to 2000 characters, NFC, not blank, no control character but newline and tab. Written once per finding and never rewritten; a second explanation of the same finding is 409. Answers 201 with the explanation and when it was written. A body that is not exactly this is 422. A finding that does not exist, anyone but the owner of the work, and any request while the faculty's switch is off get 404. It is not evidence of authorship.",
  request: {
    params: closed({ documentId: WorkId }),
    contentType: "application/json",
    maxBodyBytes: 16 * 1024,
    body: closed({ segmentRef: SegmentRef, messageId: Uuid, text: ExplanationText }),
  },
  responses: [{ status: 201, description: "the explanation", body: Explanation }],
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

export const assistantMatchRoutes = [
  assistantMatchGet,
  assistantMatchPost,
  assistantMatchExplanationPost,
] as const;

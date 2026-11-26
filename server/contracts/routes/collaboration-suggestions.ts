import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

import { WorkId } from "./collaboration.ts";
import { MUTATION_GUARD } from "./shared.ts";

// SRV-ED42-PRIJEDLOZI (Ductus#2058, PITANJE ED-42; owner approval in chat on
// 26 Nov 2026): a teacher's text suggestions (SRV-8F, D-34, C-9, D-266 t. 1;
// server/collaboration/suggestions). A suggestion is a record of its own with
// an anchor, never a change of the work: the text changes only when the
// student owner accepts it and publishes the answered bytes with its own
// live.document.put (source "teacher-suggestion"). Reads are POST too, so a
// work id never lands in a URL. Identity, role and author are never in the
// body: the RPCs take them from the session. Database: collaboration.suggestion
// and its three RPCs (20261220190000).

const CODE_POINT = "[\\uD800-\\uDBFF][\\uDC00-\\uDFFF]";
const END = "(?![\\s\\S])";
/** A suggestion id: a lowercase UUID, as the database writes it. */
export const SuggestionId = Type.String({
  pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
});
/** The sha256 of a live state, as its ETag carries it. */
const ContentHash = Type.String({ pattern: "^[0-9a-f]{64}$" });
const NodeId = Type.String({
  pattern:
    "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$",
});
const anchorText = (max: number) =>
  Type.String({ pattern: `^(?:${CODE_POINT}|[^\\uD800-\\uDFFF]){0,${max}}${END}` });
const Offset = Type.Integer({ minimum: 0, maximum: 1_000_000 });
/** isTextAnchorInput, as the anchor of a comment: exactly six fields. */
const TextAnchor = closed({
  nodeId: NodeId,
  quote: Type.String({ pattern: `^(?:${CODE_POINT}|[^\\uD800-\\uDFFF]){1,500}${END}` }),
  prefix: anchorText(64),
  suffix: anchorText(64),
  startHint: Offset,
  endHint: Offset,
});
/**
 * isSuggestionText: 0 to 2000 code points; empty removes the quote. NFC, no
 * control and no bidi character and a text other than the quote stay the
 * server's (422).
 */
const SuggestionText = Type.String({
  pattern: `^(?:${CODE_POINT}|[^\\uD800-\\uDFFF]){0,2000}${END}`,
});
const Window = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$" });
const literals = <T extends string>(values: readonly T[]) =>
  Type.Union(values.map((value) => Type.Literal(value)));

/** One suggestion as both sides read it: no person, the time in the P-03 window. */
const SuggestionView = closed({
  suggestionId: SuggestionId,
  anchor: TextAnchor,
  text: Type.String(),
  state: literals(["pending", "accepted", "rejected"]),
  isOwn: Type.Boolean(),
  baseHash: ContentHash,
  createdWindow: Window,
  decidedWindow: Type.Union([Window, Type.Null()]),
});

const COMMON_ERRORS = [
  ...MUTATION_GUARD,
  error(401, "unauthorized"),
  error(415, "unsupported_media_type"),
  error(400, "invalid_json"),
  error(422, "invalid_input"),
  error(404, "not_found"),
  error(503, "unavailable"),
] as const;

export const suggestionsList = defineRoute({
  id: "collaboration.suggestions-list.post",
  method: "POST",
  path: "/api/v1/suggestions/list",
  inventory: "app/api/suggestions/list/route.ts",
  access: "owner_or_course_teacher",
  summary:
    "The text suggestions of a work (ED-42), the same rows for its student owner and every teacher of it, oldest first, at most 500: {suggestions: [{suggestionId, anchor, text, state, isOwn, baseHash, createdWindow, decidedWindow}]}. state is pending, accepted or rejected; isOwn marks a teacher's own suggestion and is false for the student; baseHash is the live state the suggestion was made on; times are in the 5-minute window of P-03. The body is {documentId}, at most 1 KiB. Another's, an unknown and a malformed work are 404.",
  request: {
    contentType: "application/json",
    maxBodyBytes: 1024,
    body: closed({ documentId: WorkId }),
  },
  responses: [
    {
      status: 200,
      description: "the suggestions of the work",
      body: closed({ suggestions: Type.Array(SuggestionView, { maxItems: 500 }) }),
    },
  ],
  errors: COMMON_ERRORS,
});

export const suggestionsPost = defineRoute({
  id: "collaboration.suggestions.post",
  method: "POST",
  path: "/api/v1/suggestions",
  inventory: "app/api/suggestions/route.ts",
  access: "course_teacher",
  summary:
    "A teacher of a work suggests a text for an anchored quote of its live state (ED-42): {documentId, anchor, text}, at most 16 KiB; an empty text removes the quote, a text equal to the quote is 422. The anchor must still select exactly that quote in the live state the teacher reads (a teacher's read writes the access log). 200 {suggestionId, baseHash}. The work does not change: only its student owner can accept. A state that changed meanwhile, a work with nothing published, a submitted work and a work with 500 suggestions are 409; the student owner is 403; another's, an unknown and a malformed work are 404.",
  request: {
    contentType: "application/json",
    maxBodyBytes: 16 * 1024,
    body: closed({ anchor: TextAnchor, documentId: WorkId, text: SuggestionText }),
  },
  responses: [
    {
      status: 200,
      description: "the new suggestion and the live state it was made on",
      body: closed({ suggestionId: SuggestionId, baseHash: ContentHash }),
    },
  ],
  errors: [...COMMON_ERRORS, error(403, "forbidden"), error(409, "conflict")],
});

/** The recorded change of an accepted suggestion (SuggestionChange): UTF-16 offsets in the node's text. */
const SuggestionChange = closed({
  source: Type.Literal("teacher-suggestion"),
  suggestionId: SuggestionId,
  nodeId: NodeId,
  start: Offset,
  end: Offset,
  removed: Type.String(),
  inserted: Type.String(),
});

export const suggestionsAccept = defineRoute({
  id: "collaboration.suggestion-accept.post",
  method: "POST",
  path: "/api/v1/suggestions/accept",
  inventory: "app/api/suggestions/accept/route.ts",
  access: "student_owner",
  summary:
    'The student owner accepts a pending suggestion (ED-42): {suggestionId}, at most 1 KiB. The server applies it to the current live state and answers 200 {suggestionId, state: "accepted", baseHash, text, change}: text is the exact JCS bytes of the new document for the student\'s own live.document.put, baseHash the live state it was applied to, change the recorded change with source "teacher-suggestion". Nothing else is written: the work changes only with that put. A suggestion decided before, one whose quote no longer stands in the live state and a submitted work are 409 and the suggestion stays as it was; a teacher of the work is 403; another\'s and an unknown suggestion are 404.',
  request: {
    contentType: "application/json",
    maxBodyBytes: 1024,
    body: closed({ suggestionId: SuggestionId }),
  },
  responses: [
    {
      status: 200,
      description: "the accepted suggestion applied to the live state",
      body: closed({
        suggestionId: SuggestionId,
        state: Type.Literal("accepted"),
        baseHash: ContentHash,
        text: Type.String(),
        change: SuggestionChange,
      }),
    },
  ],
  errors: [...COMMON_ERRORS, error(403, "forbidden"), error(409, "conflict")],
});

export const suggestionsReject = defineRoute({
  id: "collaboration.suggestion-reject.post",
  method: "POST",
  path: "/api/v1/suggestions/reject",
  inventory: "app/api/suggestions/reject/route.ts",
  access: "student_owner",
  summary:
    "The student owner rejects a pending suggestion (ED-42): {suggestionId}, at most 1 KiB; 204. The work does not change. A suggestion decided before and a submitted work are 409; a teacher of the work is 403; another's and an unknown suggestion are 404.",
  request: {
    contentType: "application/json",
    maxBodyBytes: 1024,
    body: closed({ suggestionId: SuggestionId }),
  },
  responses: [{ status: 204, description: "rejected" }],
  errors: [...COMMON_ERRORS, error(403, "forbidden"), error(409, "conflict")],
});

export const collaborationSuggestionsRoutes = [
  suggestionsList,
  suggestionsPost,
  suggestionsAccept,
  suggestionsReject,
] as const;

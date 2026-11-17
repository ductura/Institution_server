import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

// Literal port of Ductus 078c780 app/api/live/[documentId]/route.ts and
// src/server/collaboration/live-route.ts (B-LIVE, BACKEND 4.12 point 6): the
// student owner publishes the last state of the work with PUT, and every
// reader gets it with GET through one function, the same status, bytes and
// ETag for the owner and the teacher (PRODUCT §5 rule 5). The GET declares
// ductus-protocol in RequestSpec.headers (DAN-930-1), as evidence does; the
// other headers it reads are named in the summary and the vectors.
// No handler yet (CONTRACT_ONLY).

const CODE_POINT = "[\\uD800-\\uDBFF][\\uDC00-\\uDFFF]";
/** isDocumentId: 1 to 256 code points, trimmed, no control character. */
const WorkId = Type.String({
  pattern: `^(?!\\s)(?:${CODE_POINT}|[^\\u0000-\\u001f\\u007f-\\u009f\\uD800-\\uDFFF]){1,256}(?<!\\s)(?![\\s\\S])`,
});
const Token = Type.String({
  pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
});
/** A document snapshot (CanonicalDocument); its exact JCS bytes are the server's check (422). */
const Snapshot = Type.Object({}, { additionalProperties: true });
const params = closed({ documentId: WorkId });

/** 2 MiB, MAX_DOCUMENT_SNAPSHOT_BYTES. */
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;

export const liveDocumentGet = defineRoute({
  id: "live.document.get",
  method: "GET",
  path: "/api/v1/live/{documentId}",
  inventory: "app/api/live/[documentId]/route.ts",
  access: "owner_or_course_teacher",
  summary:
    'The last published state of a work, the same bytes and ETag for the owner and the teacher. The request carries `ductus-protocol: 1` (and Sec-Fetch-Site same-origin when the browser sends it), else 403; a teacher\'s read writes the access log. `If-None-Match: "<etag>"` with the ETag last read answers 304. After the submission the bytes are the submitted revision, marked `ductus-live-state: submitted`. 204 when nothing is published yet.',
  request: { params, headers: closed({ "ductus-protocol": Type.Literal("1") }) },
  responses: [
    {
      status: 200,
      description: "the snapshot",
      body: Snapshot,
      headers: ["etag"],
    },
    { status: 204, description: "nothing published yet" },
    {
      status: 304,
      description: "the state of the ETag sent",
      headers: ["etag"],
    },
  ],
  errors: [
    error(403, "forbidden"),
    error(401, "unauthorized"),
    error(404, "not_found"),
    error(422, "invalid_document"),
    error(503, "unavailable"),
  ],
});

export const liveDocumentPut = defineRoute({
  id: "live.document.put",
  method: "PUT",
  path: "/api/v1/live/{documentId}",
  inventory: "app/api/live/[documentId]/route.ts",
  access: "student_owner",
  summary:
    'Publishes the last state of a work (the student owner only). The body is the exact JCS bytes of a valid document snapshot, at most 2 MiB. The request carries exactly one precondition: `If-None-Match: *` for the first write or `If-Match: "<token>"` with the last token, else 428. 200 {outcome, token} when accepted or unchanged; 409 {outcome: "conflict", token} with the current token (null when nothing is published yet) when the token is stale. The session is checked before the first body byte.',
  request: {
    params,
    contentType: "application/json",
    maxBodyBytes: MAX_SNAPSHOT_BYTES,
    body: Snapshot,
  },
  responses: [
    {
      status: 200,
      description: "accepted, or the same state again",
      body: closed({
        outcome: Type.Union([Type.Literal("accepted"), Type.Literal("unchanged")]),
        token: Token,
      }),
    },
    {
      status: 409,
      description: "the token is stale: the current one, null when nothing is published",
      body: closed({
        outcome: Type.Literal("conflict"),
        token: Type.Union([Token, Type.Null()]),
      }),
    },
  ],
  errors: [
    error(403, "forbidden"),
    error(415, "unsupported_media_type"),
    error(401, "unauthorized"),
    error(428, "precondition_required"),
    error(404, "not_found"),
    error(413, "too_large"),
    error(408, "timeout"),
    error(400, "bad_request"),
    error(422, "invalid_document"),
    error(503, "unavailable"),
  ],
});

export const liveRoutes = [liveDocumentGet, liveDocumentPut] as const;

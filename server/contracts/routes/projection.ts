import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

import { ProcessSummaryV1 } from "./process-summary-shape.ts";
import { MUTATION_GUARD } from "./shared.ts";

// Literal port of Ductus 078c780 app/api/process-summary/route.ts and
// src/server/projection/process-summary.ts (B-13): the one process summary of
// a work, the same JCS bytes for the student and the teacher (PRODUCT §5
// rule 5). POST so the work id never lands in a URL. No handler yet
// (CONTRACT_ONLY).

export const processSummaryPost = defineRoute({
  id: "projection.process-summary.post",
  method: "POST",
  path: "/api/v1/process-summary",
  inventory: "app/api/process-summary/route.ts",
  access: "owner_or_course_teacher",
  summary:
    "The process summary of one work, built from the accepted evidence only, as its JCS bytes. The body is exactly {documentId}, at most 1 KiB; any other key is 422. A work the caller may not read, or that does not exist, is 404; a record that does not verify is 503, never a partial summary.",
  request: {
    contentType: "application/json",
    maxBodyBytes: 1024,
    body: closed({ documentId: Type.String() }),
  },
  responses: [{ status: 200, description: "the summary", body: ProcessSummaryV1 }],
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

export const projectionRoutes = [processSummaryPost] as const;

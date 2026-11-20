import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

import { Minute, ProcessSummaryV1 } from "./process-summary-shape.ts";
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

const processSummaryDetailsPost = defineRoute({
  ...processSummaryPost,
  id: "projection.process-summary-details.post",
  path: "/api/v1/process-summary/details",
  inventory: "app/api/process-summary/details/route.ts",
  summary:
    "The same accepted record for the owner and course teacher, with active editing minutes (sum of session spans excluding record gaps) and the coarse times of recorded imports and assistant transfers.",
  responses: [
    {
      status: 200,
      description: "the summary and its details",
      body: closed({
        summary: ProcessSummaryV1,
        activeEditingMinutes: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
        keyEvents: Type.Array(
          closed({
            kind: Type.Union([Type.Literal("import"), Type.Literal("ai-transfer")]),
            at: closed({ from: Minute, to: Minute }),
          }),
        ),
      }),
    },
  ],
});

export const projectionRoutes = [processSummaryPost, processSummaryDetailsPost] as const;

import { Type } from "@sinclair/typebox";

import { AiTransferRecordV1 } from "../evidence-transfer/index.ts";
import { SHA256_HEX_PATTERN, UUID_V4_PATTERN } from "../import/index.ts";
import { closed, defineRoute, error } from "../schema/index.ts";

import { WorkId } from "./collaboration.ts";
import { MUTATION_GUARD } from "./shared.ts";

// SRV-1809 (Ductus#2059 c.7208831876; evidence-segment-v4, step 3): the student
// who owns a work records that a part of an answer of the assistant went into
// the work. The client sends the answer's id and the text it took; the server
// checks that the text is an exact, contiguous part of that answer, hashes it,
// never keeps it, and returns the record `ductus-ai-transfer-v1` that a v4
// segment points at by `aiTransferId` and `aiTransferSha256`. Provider, model
// and purpose come from the answer's request; the phase from the state of the
// work; the time is a whole minute of the database clock. Database:
// assistant.create_ai_transfer (20261220440000).

/** The longest text one transfer takes: the bound of assistant.create_ai_transfer. */
export const AI_TRANSFER_TEXT_MAX = 40_000;

export const aiTransferPost = defineRoute({
  id: "work.ai-transfer.post",
  method: "POST",
  path: "/api/v1/works/{documentId}/ai-transfers",
  inventory: "app/api/works/[documentId]/ai-transfers/route.ts",
  access: "student_owner",
  summary:
    "The student who owns the work records a transfer from an answer of the assistant, exactly {responseId, text}: the text 1 to 40000 characters and an exact, contiguous part of that answer, compared byte for byte without normalization. The server keeps only the text's SHA-256. Answers 201 with the record ductus-ai-transfer-v1, its id and the SHA-256 of its JCS text, which a v4 segment carries. A body that is not exactly this, a text that is not part of the answer, and a work that already has the most transfers are 422. Another's or an unknown work or answer, and anyone but the owner, get 404.",
  request: {
    params: closed({ documentId: WorkId }),
    contentType: "application/json",
    maxBodyBytes: 192 * 1024,
    body: closed({
      responseId: Type.String({ pattern: UUID_V4_PATTERN }),
      text: Type.String({ minLength: 1, maxLength: AI_TRANSFER_TEXT_MAX }),
    }),
  },
  responses: [
    {
      status: 201,
      description: "the record of the transfer",
      body: closed({
        aiTransferId: Type.String({ pattern: UUID_V4_PATTERN }),
        aiTransferSha256: Type.String({ pattern: SHA256_HEX_PATTERN }),
        record: AiTransferRecordV1,
      }),
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

export const aiTransferRoutes = [aiTransferPost] as const;

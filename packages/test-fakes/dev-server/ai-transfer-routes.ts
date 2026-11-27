// The record of a transfer from an answer of the assistant on the dev fake
// server (work.ai-transfer.post, SRV-1809): the student who owns the work
// records that a part of the one invented answer (assistant-match-routes)
// went into the work; anyone else and any other answer read 404, a text that
// is not an exact part of the answer 422. The record carries the SHA-256 of
// the text and never the text; the real rule is assistant.create_ai_transfer.
// Provider, model, purpose and phase are invented and fixed here.
import { createHash, randomUUID } from "node:crypto";

import {
  canonicalAiTransferRecordV1,
  parseAiTransferRecordV1Text,
} from "../../../server/contracts/index.ts";

import { ANSWER_TEXT, CONVERSATION, MESSAGE } from "./assistant-match-routes.ts";
import type { Handlers } from "./server.ts";
import { readerOf } from "./state.ts";

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

export const AI_TRANSFER_HANDLERS: Handlers = {
  "work.ai-transfer.post": ({ state, account, params, body, now }) => {
    if (account === null) return { error: "unauthorized" };
    const work = state.works.find((w) => w.documentId === params.documentId);
    if (work === undefined || readerOf(state, work, account) !== "owner") {
      return { error: "not_found" };
    }
    if (body.responseId !== MESSAGE) return { error: "not_found" };
    if (!ANSWER_TEXT.includes(body.text)) return { error: "invalid_input" };
    const text = canonicalAiTransferRecordV1({
      transferSchema: "ductus-ai-transfer-v1",
      transferId: randomUUID(),
      documentId: work.documentId,
      conversationId: CONVERSATION,
      responseId: MESSAGE,
      providerId: "provider-test-a",
      modelId: "model-test-1",
      purposeCatalogVersion: 1,
      purposeId: "proofreading",
      phaseId: "drafting",
      textSha256: sha256(body.text),
      // A whole UTC minute (D-24), as the record allows.
      transferredAt: new Date(Math.floor(now.getTime() / 60_000) * 60_000).toISOString(),
    });
    const parsed = parseAiTransferRecordV1Text(text);
    if (!parsed.ok) throw new Error(`dev fake ai transfer record: ${parsed.code}`);
    return {
      status: 201,
      body: {
        aiTransferId: parsed.record.transferId,
        aiTransferSha256: sha256(text),
        record: parsed.record,
      },
    };
  },
};

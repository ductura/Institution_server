// SRV-1809 (Ductus#2059 c.7208831876; evidence-segment-v4, step 3): the
// database port of the record of a transfer from an answer of the assistant
// into a work (20261220440000). One withActor transaction calls
// assistant.create_ai_transfer, which checks that the caller owns the work and
// the answer, that the text is an exact part of the answer, hashes the text,
// never keeps it, and returns the new record: its id, the SHA-256 of its
// canonical text and that text. ZD401 is unauthenticated, ZD403 (another's or
// an unknown work or answer, one answer, C-23) not_found, ZD422 invalid,
// anything else unavailable; a row of an unexpected shape is unavailable too.
// Reading the record against its contract is the route's.
import type { WithActor } from "../index.ts";

export type AiTransferCreated = {
  readonly transferId: string;
  readonly recordSha256: string;
  readonly recordText: string;
};
export type AiTransferCreateOutcome =
  | ({ readonly status: "ok" } & AiTransferCreated)
  | { readonly status: "unauthenticated" | "not_found" | "invalid" | "unavailable" };

export type AiTransfers = {
  /** The student owner records that `text`, a part of the answer `responseId`, went into the work. */
  create(
    token: string,
    documentId: string,
    responseId: string,
    text: string,
  ): Promise<AiTransferCreateOutcome>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;

class Malformed extends Error {}

function codeOf(thrown: unknown): unknown {
  try {
    return thrown && typeof thrown === "object" && "code" in thrown ? thrown.code : undefined;
  } catch {
    return undefined;
  }
}

function failureOf(thrown: unknown): Exclude<AiTransferCreateOutcome, { status: "ok" }> {
  if (thrown instanceof Malformed) return { status: "unavailable" };
  const code = codeOf(thrown);
  if (code === "ZD401") return { status: "unauthenticated" };
  if (code === "ZD403") return { status: "not_found" };
  if (code === "ZD422") return { status: "invalid" };
  return { status: "unavailable" };
}

function createdOf(row: Record<string, unknown>): AiTransferCreated {
  const { transferId, recordSha256, recordText } = row;
  if (
    typeof transferId !== "string" ||
    !UUID.test(transferId) ||
    typeof recordSha256 !== "string" ||
    !SHA256.test(recordSha256) ||
    typeof recordText !== "string" ||
    recordText === ""
  ) {
    throw new Malformed();
  }
  return { transferId, recordSha256, recordText };
}

export function createAiTransfers(withActor: WithActor): AiTransfers {
  return {
    async create(token, documentId, responseId, text) {
      try {
        return await withActor(token, async (tx): Promise<AiTransferCreateOutcome> => {
          const rows = (
            await tx.query<Record<string, unknown>>(
              'SELECT transfer_id::text AS "transferId", record_sha256 AS "recordSha256", record_text AS "recordText" FROM assistant.create_ai_transfer($1, $2::uuid, $3)',
              [documentId, responseId, text],
            )
          ).rows;
          if (rows.length !== 1) throw new Malformed();
          return { status: "ok", ...createdOf(rows[0]!) };
        });
      } catch (thrown) {
        return failureOf(thrown);
      }
    },
  };
}

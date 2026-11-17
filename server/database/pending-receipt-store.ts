// The worker's receipt store (DAN-820, VS-1b part 1, 820b-2b-2; plan of
// attack ductura/server#146 S-2, S-3, S-5). Ductus has the port
// (pending-receipt-signing.ts) and the function, not an adapter: this is the
// adapter over app.worker_attach_receipt_signature, with the key read of
// 820b-2a. A command that fails checkedAttachCommand is the function's own
// `invalid` before the database; the answer is one outcome of the function
// or `unavailable` with a closed code, never the driver's text.
import type { Pool } from "pg";

import { isPlainObject } from "../domain/index.ts";

import { checkedAttachCommand } from "./attach-command.ts";
import { exactRows, run } from "./pending-receipt-queue.ts";
import type {
  AttachReceiptSignatureOutcome,
  PendingReceiptStore,
} from "./pending-receipt-signing.ts";
import { readReceiptKeys } from "./receipt-keys.ts";

const ATTACH_SQL = `SELECT outcome, signature
  FROM app.worker_attach_receipt_signature($1::uuid, $2::text, $3::jsonb)`;
const WITH_SIGNATURE = new Set(["signed", "already_signed"]);
const WITHOUT_SIGNATURE = new Set([
  "invalid",
  "not_found",
  "unsupported_schema",
  "digest_mismatch",
  "key_unknown",
  "key_scope",
  "key_revoked",
  "key_not_valid",
]);

const fail = (reason: "row_malformed" | "database_error"): AttachReceiptSignatureOutcome => ({
  outcome: "unavailable",
  reason,
});

async function attachSignature(
  db: Pick<Pool, "query">,
  command: unknown,
): Promise<AttachReceiptSignatureOutcome> {
  const sent = checkedAttachCommand(command);
  if (sent === null) return { outcome: "invalid" };
  const values = [sent.receiptId, sent.payloadDigestSha256, JSON.stringify(sent.signature)];
  const answer = await run(db, ATTACH_SQL, values);
  if (answer === undefined) return fail("database_error");
  const list = exactRows(answer, ["outcome", "signature"]);
  if (list?.length !== 1) return fail("row_malformed");
  const { outcome, signature } = list[0] as Record<string, unknown>;
  if (typeof outcome !== "string") return fail("row_malformed");
  // The stored signature is passed on as it is: the caller verifies it.
  if (WITH_SIGNATURE.has(outcome) && isPlainObject(signature)) {
    return { outcome, signature } as AttachReceiptSignatureOutcome;
  }
  if (WITHOUT_SIGNATURE.has(outcome) && signature === null) {
    return { outcome } as AttachReceiptSignatureOutcome;
  }
  return fail("row_malformed");
}

/**
 * The worker's receipt store over a pool of the worker's own login (a member
 * of ductus_worker only); the web process never builds it (D-71, D-102).
 */
export function createPendingReceiptStore(db: Pick<Pool, "query">): PendingReceiptStore {
  return {
    receiptKeys: (evidenceDomainId) => readReceiptKeys(db, evidenceDomainId),
    attachSignature: (command) => attachSignature(db, command),
  };
}

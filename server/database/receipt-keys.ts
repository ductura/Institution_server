// The worker's read of a domain's receipt keys (DAN-820, VS-1b part 1,
// 820b-2a; plan of attack ductura/server#146 S-2, S-3, S-5). Ductus has the
// port (ReceiptKeysRead) and the function, not an adapter: this is the
// adapter over app.worker_receipt_keys. The function returns only Ed25519
// receipt keys of the domain asked for, so the adapter fills in those
// constants; every row is checked, and a row of another form makes the whole
// read unavailable, never a shorter list. Only the form is checked here: the
// verifier checks the key it uses, so one bad key never blocks the domain.
import type { Pool } from "pg";

import {
  canonicalInstant,
  isEvidenceDomainId,
  isPublicVerificationKey,
  type EvidenceDomainKey,
} from "../domain/index.ts";

import type { ReceiptKeysRead } from "./pending-receipt-signing.ts";
import { exactRows, run } from "./pending-receipt-queue.ts";

// ISO 8601 in UTC with milliseconds, formatted by the database clock's own value.
const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;
const iso = (column: string) => `to_char(${column} AT TIME ZONE 'UTC', ${ISO}) AS ${column}`;
const KEYS_SQL = `SELECT key_id, key_version, key_base64url,
       ${iso("valid_from")}, ${iso("valid_to")}, ${iso("revoked_at")}
  FROM app.worker_receipt_keys($1::uuid)`;
const COLUMNS = ["key_id", "key_version", "key_base64url", "valid_from", "valid_to", "revoked_at"];

const fail = (reason: "request_invalid" | "row_malformed" | "database_error"): ReceiptKeysRead => ({
  status: "unavailable",
  reason,
});
const instantOrNull = (value: unknown): value is string | null =>
  value === null || canonicalInstant(value);

/**
 * Every receipt key of the domain, revoked and retired ones included, over a
 * pool of the worker's own login (a member of ductus_worker only); the
 * worker verifies its own signature with these, never with the signer's key.
 */
export async function readReceiptKeys(
  db: Pick<Pool, "query">,
  evidenceDomainId: string,
): Promise<ReceiptKeysRead> {
  if (!isEvidenceDomainId(evidenceDomainId)) return fail("request_invalid");
  const answer = await run(db, KEYS_SQL, [evidenceDomainId]);
  if (answer === undefined) return fail("database_error");
  const list = exactRows(answer, COLUMNS);
  if (list === null) return fail("row_malformed");
  const keys: EvidenceDomainKey[] = [];
  for (const row of list) {
    const { key_id: keyId, key_version: keyVersion, key_base64url: keyBase64Url } = row;
    const { valid_from: validFrom, valid_to: validTo, revoked_at: revokedAt } = row;
    const key = { algorithm: "Ed25519", keyId, keyVersion, encoding: "spki-der", keyBase64Url };
    if (
      !isPublicVerificationKey(key) ||
      !canonicalInstant(validFrom) ||
      !instantOrNull(validTo) ||
      !instantOrNull(revokedAt) ||
      keys.some((k) => k.keyId === key.keyId)
    ) {
      return fail("row_malformed");
    }
    keys.push({ ...key, evidenceDomainId, purpose: "receipt", validFrom, validTo, revokedAt });
  }
  return { status: "ok", keys };
}

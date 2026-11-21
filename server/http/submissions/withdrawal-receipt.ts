// SRV-1903: the signed receipt of a withdrawal, signed and bound once as the
// submission receipt v2 is (server/evidence/submission-receipt.ts). The
// database freezes the receipt text with the key it names
// (app.withdraw_submission); this checks the text against the withdrawal it
// belongs to, signs the schema name, a newline and the SHA-256 of the text,
// verifies the signature and binds it (app.attach_withdrawal_receipt). Every
// success hands out what the database stored, never the signature made here,
// so a retry or a second tab gets the same receipt. Anything else fails
// closed: no receipt, 503.
//
// The text is flat JSON of string values in UTF-16 key order (JCS, RFC 8785),
// so JSON.stringify of the parsed object in that order is its canonical form.
import { createHash } from "node:crypto";

import { WITHDRAWAL_RECEIPT_SCHEMA } from "../../contracts/index.ts";
import type { StoredWithdrawalReceipt, SubmissionWithdrawals } from "../../database/index.ts";
import type { SigningKeyProvider } from "../../external/keys/index.ts";

/** The payload keys in UTF-16 order, as the database writes them. */
export const WITHDRAWAL_RECEIPT_KEYS = [
  "assignmentId",
  "dueAt",
  "evidenceDomainId",
  "principalId",
  "receiptSchema",
  "signedAt",
  "submissionId",
  "submissionReceiptSha256",
  "withdrawalId",
  "withdrawnAt",
] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const MICROSECOND = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u;
const SIGNATURE = /^[A-Za-z0-9_-]{85}[AQgw]$/u;
const FORMAT: Record<(typeof WITHDRAWAL_RECEIPT_KEYS)[number], RegExp> = {
  assignmentId: UUID,
  dueAt: MICROSECOND,
  evidenceDomainId: UUID,
  principalId: UUID,
  receiptSchema: /^ductus-submission-withdrawal-receipt-v1$/u,
  signedAt: MICROSECOND,
  submissionId: UUID,
  submissionReceiptSha256: SHA256,
  withdrawalId: UUID,
  withdrawnAt: MICROSECOND,
};

export type WithdrawalReceiptPayload = Record<(typeof WITHDRAWAL_RECEIPT_KEYS)[number], string>;
export type SignedWithdrawalReceipt = {
  readonly payload: WithdrawalReceiptPayload;
  readonly payloadDigestSha256: string;
  readonly signature: {
    readonly algorithm: "Ed25519";
    readonly keyId: string;
    readonly keyVersion: string;
    readonly signatureEncoding: "raw";
    readonly signatureBase64Url: string;
  };
};

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest();

/** The schema name, a newline and the SHA-256 of the text: what the key signs. */
export function withdrawalSigningInput(text: string): Uint8Array {
  return new Uint8Array(
    Buffer.concat([
      Buffer.from(`${WITHDRAWAL_RECEIPT_SCHEMA}\n`, "utf8"),
      sha256(Buffer.from(text, "utf8")),
    ]),
  );
}

/**
 * The payload of a stored text, or null when it is not exactly the canonical
 * receipt of this withdrawal with this digest.
 */
export function checkedWithdrawalPayload(
  text: unknown,
  digest: unknown,
  withdrawalId: string,
): WithdrawalReceiptPayload | null {
  if (typeof text !== "string" || typeof digest !== "string" || !SHA256.test(digest)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const fields = parsed as Record<string, unknown>;
  const keys = Object.keys(fields);
  if (keys.length !== WITHDRAWAL_RECEIPT_KEYS.length) return null;
  for (const [index, key] of WITHDRAWAL_RECEIPT_KEYS.entries()) {
    const value = fields[key];
    if (keys[index] !== key || typeof value !== "string" || !FORMAT[key].test(value)) return null;
  }
  if (JSON.stringify(fields) !== text) return null;
  if (sha256(Buffer.from(text, "utf8")).toString("hex") !== digest) return null;
  if (fields.withdrawalId !== withdrawalId) return null;
  return fields as WithdrawalReceiptPayload;
}

function signatureOf(value: unknown): SignedWithdrawalReceipt["signature"] | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const s = value as Record<string, unknown>;
  const keys = Object.keys(s).sort();
  if (
    keys.join(",") !== "algorithm,keyId,keyVersion,signatureBase64Url,signatureEncoding" ||
    s.algorithm !== "Ed25519" ||
    s.signatureEncoding !== "raw" ||
    typeof s.keyId !== "string" ||
    s.keyId.length < 1 ||
    s.keyId.length > 2048 ||
    typeof s.keyVersion !== "string" ||
    s.keyVersion.length < 1 ||
    s.keyVersion.length > 256 ||
    typeof s.signatureBase64Url !== "string" ||
    !SIGNATURE.test(s.signatureBase64Url)
  ) {
    return null;
  }
  return {
    algorithm: "Ed25519",
    keyId: s.keyId,
    keyVersion: s.keyVersion,
    signatureEncoding: "raw",
    signatureBase64Url: s.signatureBase64Url,
  };
}

/** A stored receipt with its bound signature as the wire receipt, or null. */
export function signedWithdrawalReceipt(
  text: unknown,
  digest: unknown,
  signature: unknown,
  withdrawalId: string,
): SignedWithdrawalReceipt | null {
  const payload = checkedWithdrawalPayload(text, digest, withdrawalId);
  const envelope = signatureOf(signature);
  if (payload === null || envelope === null) return null;
  return { payload, payloadDigestSha256: digest as string, signature: envelope };
}

export type WithdrawalIssue =
  | { readonly status: "withdrawn"; readonly receipt: SignedWithdrawalReceipt }
  | {
      readonly status: Exclude<
        Awaited<ReturnType<SubmissionWithdrawals["withdraw"]>>["status"],
        "withdrawn" | "existing"
      >;
    }
  | { readonly status: "unavailable"; readonly code: string };

const fail = (code: string): WithdrawalIssue => ({ status: "unavailable", code });
/** A key id no signing key has (a key id is a KMS name or a fake's, never this). */
const NO_KEY: { readonly keyId: string; readonly keyVersion: string } = {
  keyId: "no-signing-key",
  keyVersion: "0",
};

/** Signs a frozen receipt outside any transaction, verifies it and binds it. */
async function bind(
  port: SubmissionWithdrawals,
  signer: SigningKeyProvider,
  token: string,
  frozen: StoredWithdrawalReceipt,
): Promise<WithdrawalIssue> {
  const payload = checkedWithdrawalPayload(
    frozen.receiptPayload,
    frozen.payloadDigestSha256,
    frozen.withdrawalId,
  );
  if (payload === null) return fail("withdrawal_payload_mismatch");
  const input = withdrawalSigningInput(frozen.receiptPayload);
  let signature: unknown;
  try {
    const signed = await signer.sign(input);
    if (!signed.ok) return fail("signing");
    signature = signed.value;
    if (signatureOf(signature) === null) return fail("signing");
    const verified = await signer.verify(input, signed.value);
    if (!verified.ok || verified.value !== true) return fail("signing");
  } catch {
    return fail("signing");
  }
  const bound = await port.attach(
    token,
    frozen.withdrawalId,
    frozen.payloadDigestSha256,
    signature,
  );
  if (bound.status !== "attached" && bound.status !== "existing")
    return fail(`attach_${bound.status}`);
  const receipt = signedWithdrawalReceipt(
    bound.receiptPayload,
    bound.payloadDigestSha256,
    bound.signature,
    frozen.withdrawalId,
  );
  return receipt === null
    ? fail("withdrawal_attached_malformed")
    : { status: "withdrawn", receipt };
}

/**
 * The student's withdrawal: frozen by the database with the signer's current
 * key, then signed and bound; a withdrawal already recorded is returned with
 * its bound signature, or bound now if it has none yet.
 */
export async function withdrawSubmission(
  port: SubmissionWithdrawals,
  signer: SigningKeyProvider,
  token: string,
  assignmentId: string,
): Promise<WithdrawalIssue> {
  // Without the signer's key the database is still asked, with a key it never
  // has: its refusals (404, 409) and a withdrawal already signed come first,
  // and a new withdrawal is refused as key_unavailable (503), writing nothing.
  let key = NO_KEY;
  try {
    const found = await signer.publicVerificationKey();
    if (found.ok) key = { keyId: found.value.keyId, keyVersion: found.value.keyVersion };
  } catch {
    key = NO_KEY;
  }
  const frozen = await port.withdraw(token, assignmentId, key);
  if (frozen.status !== "withdrawn" && frozen.status !== "existing") {
    return frozen.status === "key_unavailable" || frozen.status === "invalid"
      ? fail(frozen.status)
      : { status: frozen.status };
  }
  if (frozen.signature !== null) {
    const receipt = signedWithdrawalReceipt(
      frozen.receiptPayload,
      frozen.payloadDigestSha256,
      frozen.signature,
      frozen.withdrawalId,
    );
    return receipt === null
      ? fail("withdrawal_stored_malformed")
      : { status: "withdrawn", receipt };
  }
  return bind(port, signer, token, frozen);
}

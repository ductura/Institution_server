// The worker's attach command, checked before the database (DAN-820, VS-1b
// part 1, 820b-2b-1; plan of attack ductura/server#146 S-3). The command is
// read once into a fresh record and only that copy is checked and sent
// (820b-2b-2), so a getter or a Proxy cannot show one value to the check and
// another to the database. A command that fails here is the function's own
// `invalid`, never `unavailable`, which the caller retries as passing.
import { isPlainObject, isSha256Hex, isSignatureEnvelope } from "../domain/index.ts";

import { isUuid } from "./pending-receipt-queue.ts";
import type { AttachReceiptSignatureCommand } from "./pending-receipt-signing.ts";

const COMMAND_KEYS = ["receiptId", "payloadDigestSha256", "signature"];
const ENVELOPE_KEYS = [
  "algorithm",
  "keyId",
  "keyVersion",
  "signatureEncoding",
  "signatureBase64Url",
];

/**
 * A fresh record of exactly `keys`, in that order, each read once from an own
 * data property; an accessor, a missing, extra or symbol key, or a trap that
 * throws gives null.
 */
function copyOf(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  try {
    if (!isPlainObject(value)) return null;
    const own = Reflect.ownKeys(value);
    if (
      own.length !== keys.length ||
      !own.every((k) => typeof k === "string" && keys.includes(k))
    ) {
      return null;
    }
    const copy: Record<string, unknown> = {};
    for (const key of keys) {
      const field = Object.getOwnPropertyDescriptor(value, key);
      if (field === undefined || !("value" in field)) return null;
      copy[key] = field.value;
    }
    return copy;
  } catch {
    return null;
  }
}

/**
 * The command as it is sent, the envelope in one fixed key order, or null.
 * Narrower than the function on purpose: the receipt id only as the database
 * writes it, and only an Ed25519 envelope, the one algorithm it accepts.
 */
export function checkedAttachCommand(value: unknown): AttachReceiptSignatureCommand | null {
  const copy = copyOf(value, COMMAND_KEYS);
  const signature = copy && copyOf(copy.signature, ENVELOPE_KEYS);
  if (copy === null || !isSignatureEnvelope(signature) || signature.algorithm !== "Ed25519") {
    return null;
  }
  const { receiptId, payloadDigestSha256 } = copy;
  if (!isUuid(receiptId) || !isSha256Hex(payloadDigestSha256)) return null;
  return { receiptId, payloadDigestSha256, signature };
}

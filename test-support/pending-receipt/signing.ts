// The signer and the store of the signing tests (DAN-820, 820c-4), ported from
// Ductus src/application/evidence/sign-pending-receipt.test.ts at 333e163
// (`testSigner`, `memoryStore`). The signer answers this repo's Result
// (ReceiptSigner); every key and value is invented.
import { createHash } from "node:crypto";

import { vi } from "vitest";

import type {
  AttachReceiptSignatureCommand,
  AttachReceiptSignatureOutcome,
} from "../../server/database/index.ts";
import type { EvidenceDomainKey, SignatureEnvelope } from "../../server/domain/index.ts";

import { RECEIPT, TEXT, testKey } from "./fixtures.ts";

export type Behaviour = (
  input: Uint8Array,
  honest: () => SignatureEnvelope,
) => Promise<unknown> | unknown;

export const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest();

/** A signer over an ephemeral key; `behave` answers its envelope, wrapped as a Result. */
export function testSigner(keyId: string, behave: Behaviour = (_, honest) => honest()) {
  const { envelope, key } = testKey(keyId);
  const inputs: Uint8Array[] = [];
  const provider = {
    // The behaviour may answer a malformed value on purpose: the type is the port's.
    sign: vi.fn(async (input: Uint8Array) => {
      inputs.push(input);
      return {
        ok: true as const,
        value: (await behave(input, () => envelope(input))) as SignatureEnvelope,
      };
    }),
  };
  return { provider, key, inputs, envelope };
}

/**
 * Mirrors `app.worker_attach_receipt_signature`: the digest is taken over the
 * stored text, and the row lock makes the first attach the only one stored.
 */
export function memoryStore(
  keys: () => readonly EvidenceDomainKey[],
  gate?: (c: AttachReceiptSignatureCommand) => Promise<void>,
) {
  const texts = new Map([[RECEIPT, TEXT]]);
  const stored = new Map<string, unknown>();
  const store = {
    receiptKeys: vi.fn(async () => ({ status: "ok" as const, keys: keys() })),
    attachSignature: vi.fn(
      async (c: AttachReceiptSignatureCommand): Promise<AttachReceiptSignatureOutcome> => {
        await gate?.(c);
        const text = texts.get(c.receiptId);
        if (text === undefined) return { outcome: "not_found" };
        if (stored.has(c.receiptId)) {
          return { outcome: "already_signed", signature: stored.get(c.receiptId) };
        }
        if (sha256(text).toString("hex") !== c.payloadDigestSha256) {
          return { outcome: "digest_mismatch" };
        }
        stored.set(c.receiptId, c.signature);
        return { outcome: "signed", signature: c.signature };
      },
    ),
  };
  return { store, stored };
}

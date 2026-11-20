import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";

import { canonicalizeJcs, EVIDENCE_RECEIPT_SCHEMA_V2 } from "../../../server/domain/index.ts";
import type { Operations } from "../../contracts/index.ts";

export const FAKE_DOMAIN = "00000000-0000-4000-8000-00000000fa4e";

export const minute = (now: Date): string => `${now.toISOString().slice(0, 16)}:00.000Z`;

type CommitSuccess = Extract<Operations["evidence.commit.post"]["success"], { status: 200 }>;
export type SignedReceipt = CommitSuccess["body"]["receipt"]["signedReceipt"];
export type ReceiptSigner = ReturnType<typeof createReceiptSigner>;

/** The private key exists only in this fake server instance's signing closure. */
export function createReceiptSigner() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const key = {
    algorithm: "Ed25519",
    keyId: `lazni-kljuc-${randomUUID()}`,
    keyVersion: "0",
    encoding: "spki-der",
    keyBase64Url: publicKey.export({ type: "spki", format: "der" }).toString("base64url"),
    evidenceDomainId: FAKE_DOMAIN,
    purpose: "receipt",
    validFrom: minute(new Date()),
    validTo: null,
    revokedAt: null,
  } as const;

  return {
    key,
    signReceipt(payload: SignedReceipt["payload"]): SignedReceipt {
      // D-92 signs the domain separator followed by the raw SHA-256 of JCS.
      // Synchronous crypto keeps the in-memory revision check and write atomic.
      const digest = createHash("sha256").update(canonicalizeJcs(payload)).digest();
      const input = Buffer.concat([Buffer.from(`${EVIDENCE_RECEIPT_SCHEMA_V2}\n`), digest]);
      return {
        payload,
        payloadDigestSha256: digest.toString("hex"),
        signature: {
          algorithm: key.algorithm,
          keyId: key.keyId,
          keyVersion: key.keyVersion,
          signatureEncoding: "raw",
          signatureBase64Url: sign(null, input, privateKey).toString("base64url"),
        },
      };
    },
  };
}

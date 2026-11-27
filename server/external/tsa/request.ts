import * as asn1js from "asn1js";
import * as pkijs from "pkijs";

import { tsaFailure, type TsaResult } from "./errors.ts";
import { OID_SHA256 } from "./oids.ts";

// TimeStampReq (RFC 3161 §2.4.1) for ISTR-2 step 1. The TSA receives only the
// SHA-256 digest the caller computed (docs/plan/ISTR-2-TSA.md §5): no content,
// identifier or name ever reaches this module. Inputs are copied with
// `new Uint8Array(x)` before `.buffer` is read: a Node Buffer (and its
// `slice()`) is a view into a shared pool, whose `.buffer` holds other data.

export const DIGEST_BYTES = 32;
/** 16 bytes, of which 126 bits are random: well above the plan's 64-bit floor. */
export const NONCE_BYTES = 16;

export type RandomSource = (bytes: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer>;

const defaultRandom: RandomSource = (bytes) => crypto.getRandomValues(bytes);

/**
 * A fresh nonce for one attempt. The first byte is forced into 0x40..0x7f so
 * the INTEGER is positive, needs no leading zero and has its full length; a
 * TSA that echoes it back can be compared byte for byte.
 */
export function newNonce(random: RandomSource = defaultRandom): Uint8Array<ArrayBuffer> {
  const nonce = random(new Uint8Array(NONCE_BYTES));
  if (nonce.byteLength !== NONCE_BYTES) throw new Error("random source returned the wrong length");
  nonce[0] = ((nonce[0] ?? 0) & 0x3f) | 0x40;
  return nonce;
}

export function isDigest(digest: unknown): digest is Uint8Array {
  return digest instanceof Uint8Array && digest.byteLength === DIGEST_BYTES;
}

/** DER of TimeStampReq v1: SHA-256 imprint of `digest`, `nonce`, certReq = true, no policy. */
export function buildTimeStampRequest(
  digest: Uint8Array,
  nonce: Uint8Array,
): TsaResult<Uint8Array<ArrayBuffer>> {
  if (!isDigest(digest)) return tsaFailure("TSA_DIGEST_INVALID");
  if (nonce.byteLength < 8 || ((nonce[0] ?? 0) & 0x80) !== 0 || nonce[0] === 0)
    throw new Error("nonce must come from newNonce");
  const request = new pkijs.TimeStampReq({
    version: 1,
    messageImprint: new pkijs.MessageImprint({
      hashAlgorithm: new pkijs.AlgorithmIdentifier({
        algorithmId: OID_SHA256,
        algorithmParams: new asn1js.Null(),
      }),
      hashedMessage: new asn1js.OctetString({ valueHex: new Uint8Array(digest).buffer }),
    }),
    nonce: new asn1js.Integer({ valueHex: new Uint8Array(nonce).buffer }),
    certReq: true,
  });
  return { ok: true, value: new Uint8Array(request.toSchema().toBER(false)) };
}

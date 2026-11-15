/** Raw Ed25519 signature size (RFC 8032 §5.1.6). */
export const ED25519_SIGNATURE_BYTES = 64;
/** Unpadded base64url of 64 bytes is ceil(64 * 4 / 3) characters. */
const ED25519_SIGNATURE_BASE64URL_LENGTH = Math.ceil((ED25519_SIGNATURE_BYTES * 4) / 3);
const BASE64URL_ALPHABET = /^[A-Za-z0-9_-]+$/;

/**
 * Decodes the `signatureBase64Url` of an envelope strictly: only the
 * base64url alphabet, no padding, exactly 64 bytes, and one spelling per
 * byte string (no stray trailing bits). Anything else is null, so `verify`
 * answers `{ ok: true, value: false }` without decoding it leniently:
 * `Buffer.from(…, "base64url")` silently skips characters outside the
 * alphabet, so an envelope with an added `!` would otherwise verify.
 */
export function decodeEd25519SignatureBase64Url(text: string): Buffer | null {
  if (text.length !== ED25519_SIGNATURE_BASE64URL_LENGTH || !BASE64URL_ALPHABET.test(text)) {
    return null;
  }
  const bytes = Buffer.from(text, "base64url");
  return bytes.byteLength === ED25519_SIGNATURE_BYTES && bytes.toString("base64url") === text
    ? bytes
    : null;
}

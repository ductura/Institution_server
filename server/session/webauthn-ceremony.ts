import { createHash, createPublicKey, verify, type KeyObject } from "node:crypto";

// WebAuthn assertion check (S-1E-g, DAN-840-2b): a pure function over the
// bytes the browser sent, the expected origin and rpId, and the stored key and
// counter. Only ES256 with the 77-byte COSE key every FIDO2 key gives. The
// challenge is spent first, whatever follows; the counter is judged only after
// a valid signature, by the rule of identity.use_webauthn_credential (#180),
// which keeps the last word under concurrency.

export type CeremonyCode = "challenge_invalid" | "ceremony_invalid" | "counter_not_increased";
export type AssertionOutcome =
  | { readonly ok: true; readonly signCount: number }
  | { readonly ok: false; readonly code: CeremonyCode };

/** The bytes of the browser's answer; 840-3 finds `stored` by credential id within the session's account. */
export type AssertionInput = {
  readonly clientDataJSON: Uint8Array;
  readonly authenticatorData: Uint8Array;
  readonly signature: Uint8Array;
};
export type Expected = { readonly origin: string; readonly rpId: string };
export type StoredCredential = { readonly publicKey: Uint8Array; readonly signCount: number };
/** The challenge store's take for this session and purpose (840-2a). */
export type TakeChallenge = (challenge: unknown) => "ok" | "invalid";

const FLAG_UP = 0x01;
const FLAG_BE = 0x08;
const FLAG_BS = 0x10;
// Attested credential data and extensions: an assertion of 37 bytes carries neither.
const FLAG_AT_ED = 0x40 | 0x80;
const ASSERTION_DATA_BYTES = 37;
// COSE_Key {1: 2 (EC2), 3: -7 (ES256), -1: 1 (P-256), -2: x, -3: y}, keys in CTAP2 order.
const COSE_HEAD = Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]);
const COSE_Y = Buffer.from([0x22, 0x58, 0x20]);
export const COSE_ES256_BYTES = COSE_HEAD.length + 32 + COSE_Y.length + 32;

const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest();
const fail = (code: CeremonyCode): AssertionOutcome => ({ ok: false, code });

/** The P-256 key of a 77-byte ES256 COSE key, or null for anything else (off-curve included). */
export function coseEs256Key(cose: Uint8Array): KeyObject | null {
  const bytes = Buffer.from(cose);
  if (bytes.length !== COSE_ES256_BYTES) return null;
  if (!bytes.subarray(0, COSE_HEAD.length).equals(COSE_HEAD)) return null;
  if (!bytes.subarray(42, 45).equals(COSE_Y)) return null;
  const x = bytes.subarray(10, 42).toString("base64url");
  const y = bytes.subarray(45, 77).toString("base64url");
  try {
    return createPublicKey({ key: { kty: "EC", crv: "P-256", x, y }, format: "jwk" });
  } catch {
    return null;
  }
}

const own = (value: object, key: string): unknown =>
  Object.prototype.hasOwnProperty.call(value, key)
    ? (value as Record<string, unknown>)[key]
    : undefined;

/** The own type, challenge, origin and crossOrigin of clientDataJSON, or null. */
export function readClientData(
  bytes: Uint8Array,
): { type: unknown; challenge: unknown; origin: unknown; crossOrigin: unknown } | null {
  try {
    const parsed: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
    );
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return {
      type: own(parsed, "type"),
      challenge: own(parsed, "challenge"),
      origin: own(parsed, "origin"),
      crossOrigin: own(parsed, "crossOrigin"),
    };
  } catch {
    return null;
  }
}

export function verifyAssertion(
  input: AssertionInput,
  expected: Expected,
  stored: StoredCredential,
  take: TakeChallenge,
): AssertionOutcome {
  const client = readClientData(input.clientDataJSON);
  // Spent on every attempt, exactly once, before any other answer (840-2a deletes it whatever the value).
  const challenge = take(client?.challenge ?? null);
  if (client === null) return fail("ceremony_invalid");
  if (challenge !== "ok") return fail("challenge_invalid");
  if (client.type !== "webauthn.get" || client.origin !== expected.origin)
    return fail("ceremony_invalid");
  if (client.crossOrigin !== undefined && client.crossOrigin !== false)
    return fail("ceremony_invalid");

  const data = Buffer.from(input.authenticatorData);
  if (data.length !== ASSERTION_DATA_BYTES) return fail("ceremony_invalid");
  if (!data.subarray(0, 32).equals(sha256(Buffer.from(expected.rpId, "utf8"))))
    return fail("ceremony_invalid");
  const flags = data.readUInt8(32);
  if ((flags & FLAG_UP) === 0 || (flags & FLAG_AT_ED) !== 0) return fail("ceremony_invalid");
  // Backed up without being eligible for backup is invalid (WebAuthn Level 3).
  if ((flags & FLAG_BS) !== 0 && (flags & FLAG_BE) === 0) return fail("ceremony_invalid");

  const key = coseEs256Key(stored.publicKey);
  if (key === null) return fail("ceremony_invalid");
  let valid = false;
  try {
    const signed = Buffer.concat([data, sha256(input.clientDataJSON)]);
    valid = verify("sha256", signed, { key, dsaEncoding: "der" }, input.signature);
  } catch {
    valid = false;
  }
  if (!valid) return fail("ceremony_invalid");

  const signCount = data.readUInt32BE(33);
  const grew = signCount > stored.signCount || (signCount === 0 && stored.signCount === 0);
  return grew ? { ok: true, signCount } : fail("counter_not_increased");
}

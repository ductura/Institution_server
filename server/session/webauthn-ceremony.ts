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
const FLAG_AT = 0x40;
const FLAG_ED = 0x80;
const ASSERTION_DATA_BYTES = 37;
// COSE_Key {1: 2 (EC2), 3: -7 (ES256), -1: 1 (P-256), -2: x, -3: y}, keys in CTAP2 order.
const COSE_HEAD = Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]);
const COSE_Y = Buffer.from([0x22, 0x58, 0x20]);
export const COSE_ES256_BYTES = COSE_HEAD.length + 32 + COSE_Y.length + 32;

const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest();
const fail = (code: CeremonyCode): AssertionOutcome => ({ ok: false, code });

/** Type, exact origin and crossOrigin of readable client data. */
function clientMatches(
  client: NonNullable<ReturnType<typeof readClientData>>,
  type: "webauthn.get" | "webauthn.create",
  expected: Expected,
): boolean {
  return (
    client.type === type &&
    client.origin === expected.origin &&
    (client.crossOrigin === undefined || client.crossOrigin === false)
  );
}

/**
 * The rpId hash and the flags of authenticator data: user presence, AT as the
 * ceremony needs it, no extension data, and never backed up without being
 * eligible for backup (WebAuthn Level 3). UV is not required.
 */
function headerMatches(data: Buffer, rpId: string, attested: boolean): boolean {
  if (data.length < ASSERTION_DATA_BYTES) return false;
  if (!data.subarray(0, 32).equals(sha256(Buffer.from(rpId, "utf8")))) return false;
  const flags = data.readUInt8(32);
  if ((flags & FLAG_UP) === 0 || (flags & FLAG_ED) !== 0) return false;
  if (((flags & FLAG_AT) !== 0) !== attested) return false;
  return (flags & FLAG_BS) === 0 || (flags & FLAG_BE) !== 0;
}

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
  if (!clientMatches(client, "webauthn.get", expected)) return fail("ceremony_invalid");

  // An assertion of exactly 37 bytes: no attested credential data, no extensions.
  const data = Buffer.from(input.authenticatorData);
  if (data.length !== ASSERTION_DATA_BYTES || !headerMatches(data, expected.rpId, false))
    return fail("ceremony_invalid");

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

/** The bytes of a registration (DAN-840-2c); attestation "none", so no attestation object. */
export type RegistrationInput = {
  readonly clientDataJSON: Uint8Array;
  readonly authenticatorData: Uint8Array;
  readonly credentialId: Uint8Array;
};

/** Exactly what identity.add_webauthn_credential takes: the raw 77-byte COSE key, the counter as sent. */
export type RegistrationOutcome =
  | {
      readonly ok: true;
      readonly credentialId: Buffer;
      readonly publicKey: Buffer;
      readonly signCount: number;
    }
  | { readonly ok: false; readonly code: "challenge_invalid" | "ceremony_invalid" };

const AAGUID_BYTES = 16;
const MAX_CREDENTIAL_ID_BYTES = 1023;

/**
 * Registration check: the same client data and challenge order as
 * verifyAssertion, then authenticator data laid out as rpIdHash, flags,
 * counter, AAGUID (not checked: attestation "none"), id length (1 to 1023),
 * id and exactly one canonical ES256 COSE key, nothing after it. The id in the
 * body must be the same bytes. No signature exists to check; the session and
 * the one-time challenge carry the trust.
 */
export function verifyRegistration(
  input: RegistrationInput,
  expected: Expected,
  take: TakeChallenge,
): RegistrationOutcome {
  const refuse = (code: "challenge_invalid" | "ceremony_invalid"): RegistrationOutcome => ({
    ok: false,
    code,
  });
  const client = readClientData(input.clientDataJSON);
  const challenge = take(client?.challenge ?? null);
  if (client === null) return refuse("ceremony_invalid");
  if (challenge !== "ok") return refuse("challenge_invalid");
  if (!clientMatches(client, "webauthn.create", expected)) return refuse("ceremony_invalid");

  const data = Buffer.from(input.authenticatorData);
  const idAt = ASSERTION_DATA_BYTES + AAGUID_BYTES + 2;
  if (data.length < idAt || !headerMatches(data, expected.rpId, true))
    return refuse("ceremony_invalid");
  const idLength = data.readUInt16BE(idAt - 2);
  if (idLength < 1 || idLength > MAX_CREDENTIAL_ID_BYTES) return refuse("ceremony_invalid");
  // The rest must be exactly one canonical COSE key (coseEs256Key checks its 77 bytes).
  if (data.length < idAt + idLength) return refuse("ceremony_invalid");
  const credentialId = Buffer.from(data.subarray(idAt, idAt + idLength));
  const publicKey = Buffer.from(data.subarray(idAt + idLength));
  if (!credentialId.equals(Buffer.from(input.credentialId))) return refuse("ceremony_invalid");
  if (coseEs256Key(publicKey) === null) return refuse("ceremony_invalid");
  return { ok: true, credentialId, publicKey, signCount: data.readUInt32BE(33) };
}

import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
  type JsonWebKey,
  type KeyObject,
} from "node:crypto";

// A software FIDO2 (WebAuthn) authenticator for tests (U9, DAN-741): ES256 on
// P-256, attestation "none". It signs what a hardware key signs, so a verifier
// can be tested without one. Two failures a verifier must catch:
// - withForeignKey(): the same credential id signed by another key (wrong key);
// - clone(): a second authenticator with the same key and counter (cloned key),
//   whose counter falls behind once either one is used.

export type AuthenticatorOptions = {
  readonly rpId: string;
  readonly origin: string;
};

export type Registration = {
  readonly credentialId: Buffer;
  /** SubjectPublicKeyInfo, DER. */
  readonly publicKeySpki: Buffer;
  readonly publicKeyJwk: JsonWebKey;
  /** The COSE_Key (EC2, ES256) inside authenticatorData. */
  readonly cosePublicKey: Buffer;
  readonly clientDataJSON: Buffer;
  /** rpIdHash, flags UP|UV|AT, counter 0 and the attested credential data. */
  readonly authenticatorData: Buffer;
};

export type Assertion = {
  readonly credentialId: Buffer;
  readonly clientDataJSON: Buffer;
  /** rpIdHash, flags UP|UV, counter. */
  readonly authenticatorData: Buffer;
  /** ECDSA P-256 SHA-256, DER, over authenticatorData ‖ SHA-256(clientDataJSON). */
  readonly signature: Buffer;
  readonly signCount: number;
};

export type SoftwareAuthenticator = {
  readonly credentialId: Buffer;
  readonly signCount: number;
  register(challenge: Uint8Array): Registration;
  /** `origin` replaces the configured one, to build a wrong-origin assertion. */
  assert(challenge: Uint8Array, overrides?: { readonly origin?: string }): Assertion;
  /** A copy with the same key, credential id and counter (a cloned key). */
  clone(): SoftwareAuthenticator;
  /** The same credential id and counter, signing with another key (a wrong key). */
  withForeignKey(): SoftwareAuthenticator;
};

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;
const AAGUID_NONE = Buffer.alloc(16);

const sha256 = (data: Uint8Array): Buffer => createHash("sha256").update(data).digest();

function clientData(type: string, challenge: Uint8Array, origin: string): Buffer {
  const json = {
    type,
    challenge: Buffer.from(challenge).toString("base64url"),
    origin,
    crossOrigin: false,
  };
  return Buffer.from(JSON.stringify(json), "utf8");
}

// COSE_Key {1: 2 (EC2), 3: -7 (ES256), -1: 1 (P-256), -2: x, -3: y} in CBOR.
function coseKey(jwk: JsonWebKey): Buffer {
  const x = Buffer.from(jwk.x ?? "", "base64url");
  const y = Buffer.from(jwk.y ?? "", "base64url");
  if (x.length !== 32 || y.length !== 32) throw new Error("expected a P-256 public key");
  const head = Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01]);
  return Buffer.concat([
    head,
    Buffer.from([0x21, 0x58, 0x20]),
    x,
    Buffer.from([0x22, 0x58, 0x20]),
    y,
  ]);
}

function counterBytes(count: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(count);
  return out;
}

type State = { count: number };

function build(
  options: AuthenticatorOptions,
  credentialId: Buffer,
  publicKey: KeyObject,
  signingKey: KeyObject,
  state: State,
): SoftwareAuthenticator {
  const rpIdHash = sha256(Buffer.from(options.rpId, "utf8"));
  const jwk = publicKey.export({ format: "jwk" });
  const cose = coseKey(jwk);

  return {
    credentialId: Buffer.from(credentialId),
    get signCount() {
      return state.count;
    },
    register(challenge) {
      const idLength = Buffer.alloc(2);
      idLength.writeUInt16BE(credentialId.length);
      const authenticatorData = Buffer.concat([
        rpIdHash,
        Buffer.from([FLAG_UP | FLAG_UV | FLAG_AT]),
        counterBytes(state.count),
        AAGUID_NONE,
        idLength,
        credentialId,
        cose,
      ]);
      return {
        credentialId: Buffer.from(credentialId),
        publicKeySpki: publicKey.export({ format: "der", type: "spki" }),
        publicKeyJwk: jwk,
        cosePublicKey: cose,
        clientDataJSON: clientData("webauthn.create", challenge, options.origin),
        authenticatorData,
      };
    },
    assert(challenge, overrides) {
      state.count += 1;
      const clientDataJSON = clientData(
        "webauthn.get",
        challenge,
        overrides?.origin ?? options.origin,
      );
      const authenticatorData = Buffer.concat([
        rpIdHash,
        Buffer.from([FLAG_UP | FLAG_UV]),
        counterBytes(state.count),
      ]);
      const signature = sign(
        "sha256",
        Buffer.concat([authenticatorData, sha256(clientDataJSON)]),
        signingKey,
      );
      return {
        credentialId: Buffer.from(credentialId),
        clientDataJSON,
        authenticatorData,
        signature,
        signCount: state.count,
      };
    },
    clone: () => build(options, credentialId, publicKey, signingKey, { count: state.count }),
    withForeignKey() {
      const foreign = generateKeyPairSync("ec", { namedCurve: "P-256" });
      return build(options, credentialId, publicKey, foreign.privateKey, { count: state.count });
    },
  };
}

/** A new authenticator with a fresh P-256 key and a random 16-byte credential id. */
export function createSoftwareAuthenticator(options: AuthenticatorOptions): SoftwareAuthenticator {
  if (options.rpId === "" || options.origin === "") throw new Error("rpId and origin are required");
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return build(options, randomBytes(16), publicKey, privateKey, { count: 0 });
}

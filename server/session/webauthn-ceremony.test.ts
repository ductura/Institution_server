// DAN-840-2b (S-1E-g): the assertion check. The software authenticator of
// @ductura/test-fakes covers a wrong origin, rpId and key and a cloned key; a
// local signer here builds what it cannot (flags, type, crossOrigin, the
// bytes of clientDataJSON) and signs it properly, so each case fails on its
// own check and not on the signature. Every builder has a positive control.
import { createHash, generateKeyPairSync, sign } from "node:crypto";

import { createSoftwareAuthenticator } from "@ductura/test-fakes";
import { describe, expect, it, vi } from "vitest";

import {
  coseEs256Key,
  verifyAssertion,
  verifyRegistration,
  type TakeChallenge,
} from "./webauthn-ceremony.ts";

const ORIGIN = "https://ductura.example.invalid";
const RP_ID = "ductura.example.invalid";
const EXPECTED = { origin: ORIGIN, rpId: RP_ID };
const CHALLENGE = new Uint8Array(32).fill(7);
const ok: TakeChallenge = () => "ok";
const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest();

describe("with the software authenticator", () => {
  const setup = (rpId = RP_ID) => {
    const authenticator = createSoftwareAuthenticator({ rpId, origin: ORIGIN });
    const publicKey = authenticator.register(CHALLENGE).cosePublicKey;
    return { authenticator, stored: { publicKey, signCount: 0 } };
  };

  it("confirms a well-formed assertion and returns its counter", () => {
    const { authenticator, stored } = setup();
    const assertion = authenticator.assert(CHALLENGE);
    expect(verifyAssertion(assertion, EXPECTED, stored, ok)).toEqual({ ok: true, signCount: 1 });
  });

  it.each([
    "https://drugo.example.invalid",
    "http://ductura.example.invalid",
    "https://DUCTURA.example.invalid",
    "https://ductura.example.invalid/",
    "https://ductura.example.invalid:8443",
  ])("refuses the origin %s in the client data", (origin) => {
    const { authenticator, stored } = setup();
    const assertion = authenticator.assert(CHALLENGE, { origin });
    expect(verifyAssertion(assertion, EXPECTED, stored, ok)).toEqual({
      ok: false,
      code: "ceremony_invalid",
    });
  });

  it("refuses a cloned key whose counter fell behind, and an equal counter", () => {
    const { authenticator, stored } = setup();
    const clone = authenticator.clone();
    authenticator.assert(CHALLENGE);
    const original = authenticator.assert(CHALLENGE);
    const behind = clone.assert(CHALLENGE);
    // QA on #205: the clone really falls behind (1 against 2), not only equal.
    expect(behind.signCount).toBeLessThan(original.signCount);
    const after = { ...stored, signCount: original.signCount };
    expect(verifyAssertion(behind, EXPECTED, after, ok)).toEqual({
      ok: false,
      code: "counter_not_increased",
    });
    expect(verifyAssertion(original, EXPECTED, after, ok)).toEqual({
      ok: false,
      code: "counter_not_increased",
    });
  });

  it("refuses another key and another rpId", () => {
    const { authenticator, stored } = setup();
    const foreign = authenticator.withForeignKey().assert(CHALLENGE);
    expect(verifyAssertion(foreign, EXPECTED, stored, ok).ok).toBe(false);
    const other = setup("drugo.example.invalid");
    const assertion = other.authenticator.assert(CHALLENGE);
    expect(verifyAssertion(assertion, EXPECTED, other.stored, ok)).toEqual({
      ok: false,
      code: "ceremony_invalid",
    });
  });
});

// A local signer: the same P-256 signing a key does, over bytes the test chooses.
const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
const jwk = keys.publicKey.export({ format: "jwk" });
const coord = (value: string | undefined) => Buffer.from(value ?? "", "base64url");
const COSE = Buffer.concat([
  Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]),
  coord(jwk.x),
  Buffer.from([0x22, 0x58, 0x20]),
  coord(jwk.y),
]);
const STORED = { publicKey: COSE, signCount: 0 };

type Build = { client?: unknown; raw?: Buffer; flags?: number; count?: number; size?: number };
function build({ client, raw, flags = 0x05, count = 1, size = 37 }: Build = {}) {
  const clientDataJSON =
    raw ??
    Buffer.from(
      JSON.stringify(
        client ?? {
          type: "webauthn.get",
          challenge: Buffer.from(CHALLENGE).toString("base64url"),
          origin: ORIGIN,
          crossOrigin: false,
        },
      ),
    );
  const head = Buffer.alloc(37);
  sha256(Buffer.from(RP_ID)).copy(head);
  head.writeUInt8(flags, 32);
  head.writeUInt32BE(count, 33);
  const authenticatorData = Buffer.concat([head, Buffer.alloc(Math.max(0, size - 37))]).subarray(
    0,
    size,
  );
  const signature = sign(
    "sha256",
    Buffer.concat([authenticatorData, sha256(clientDataJSON)]),
    keys.privateKey,
  );
  return { clientDataJSON, authenticatorData, signature };
}
const client = (fields: Record<string, unknown>) => ({
  type: "webauthn.get",
  challenge: "x",
  origin: ORIGIN,
  ...fields,
});
const refused = { ok: false, code: "ceremony_invalid" };

describe("with a local signer", () => {
  it("the unchanged builder is confirmed (positive control)", () => {
    expect(verifyAssertion(build(), EXPECTED, STORED, ok)).toEqual({ ok: true, signCount: 1 });
  });

  it.each([
    ["no user presence", { flags: 0x04 }],
    ["backed up without backup eligibility", { flags: 0x15 }],
    ["attested credential data flag", { flags: 0x45 }],
    ["extension data flag", { flags: 0x85 }],
    ["36 bytes", { size: 36 }],
    ["38 bytes", { size: 38 }],
    ["type webauthn.create", { client: client({ type: "webauthn.create" }) }],
    ["crossOrigin true", { client: client({ crossOrigin: true }) }],
    ["crossOrigin as text", { client: client({ crossOrigin: "true" }) }],
    ["origin with CRLF", { client: client({ origin: `${ORIGIN}\r\n` }) }],
    ["origin with a tab", { client: client({ origin: `${ORIGIN}\t` }) }],
    ["origin with NBSP", { client: client({ origin: `${ORIGIN} ` }) }],
    ["origin with DEL", { client: client({ origin: `${ORIGIN}\u007f` }) }],
    ["no type", { client: { challenge: "x", origin: ORIGIN } }],
    ["a BOM", { raw: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), build().clientDataJSON]) }],
    ["invalid UTF-8", { raw: Buffer.from([0x7b, 0xff, 0x7d]) }],
    ["an array", { raw: Buffer.from("[]") }],
    ["null", { raw: Buffer.from("null") }],
    ["a string", { raw: Buffer.from('"webauthn.get"') }],
  ] as const)("refuses %s", (_name, change) => {
    expect(verifyAssertion(build(change), EXPECTED, STORED, ok)).toEqual(refused);
  });

  it("reads only own fields, even with a polluted prototype", () => {
    const raw = Buffer.from(`{"challenge":"x","origin":"${ORIGIN}"}`);
    const proto = Object.prototype as Record<string, unknown>;
    proto["type"] = "webauthn.get";
    try {
      expect(verifyAssertion(build({ raw }), EXPECTED, STORED, ok)).toEqual(refused);
    } finally {
      delete proto["type"];
    }
  });

  it("refuses invalid UTF-8 that a lenient decoder would turn into valid JSON", () => {
    const text = `{"type":"webauthn.get","challenge":"x","origin":"${ORIGIN}","x":"?"}`;
    const raw = Buffer.from(text);
    raw[raw.length - 3] = 0xff;
    expect(verifyAssertion(build({ raw }), EXPECTED, STORED, ok)).toEqual(refused);
    raw[raw.length - 3] = 0x3f;
    expect(verifyAssertion(build({ raw }), EXPECTED, STORED, ok).ok).toBe(true);
  });

  it("accepts 0 to 0 and refuses a stored count above a new 0", () => {
    expect(verifyAssertion(build({ count: 0 }), EXPECTED, STORED, ok)).toEqual({
      ok: true,
      signCount: 0,
    });
    expect(verifyAssertion(build({ count: 0 }), EXPECTED, { ...STORED, signCount: 5 }, ok)).toEqual(
      { ok: false, code: "counter_not_increased" },
    );
    expect(
      verifyAssertion(build({ count: 2 ** 32 - 1 }), EXPECTED, { ...STORED, signCount: 5 }, ok),
    ).toEqual({ ok: true, signCount: 2 ** 32 - 1 });
  });

  it("refuses a changed byte of the signature or of the client data", () => {
    const good = build();
    const signature = Buffer.from(good.signature);
    signature.writeUInt8(signature.readUInt8(signature.length - 1) ^ 1, signature.length - 1);
    expect(verifyAssertion({ ...good, signature }, EXPECTED, STORED, ok)).toEqual(refused);
    const clientDataJSON = Buffer.from(good.clientDataJSON.toString().replace("false", "false "));
    expect(verifyAssertion({ ...good, clientDataJSON }, EXPECTED, STORED, ok)).toEqual(refused);
    expect(verifyAssertion({ ...good, signature: Buffer.alloc(0) }, EXPECTED, STORED, ok)).toEqual(
      refused,
    );
  });
});

describe("the challenge", () => {
  it("is taken exactly once, with the client data's value, before any other answer", () => {
    const take = vi.fn<TakeChallenge>(() => "invalid");
    expect(verifyAssertion(build(), EXPECTED, STORED, take)).toEqual({
      ok: false,
      code: "challenge_invalid",
    });
    expect(take).toHaveBeenCalledExactlyOnceWith(Buffer.from(CHALLENGE).toString("base64url"));
  });

  it("is spent even when the client data cannot be read", () => {
    const take = vi.fn<TakeChallenge>(() => "ok");
    const raw = Buffer.from([0xff]);
    expect(verifyAssertion(build({ raw }), EXPECTED, STORED, take)).toEqual(refused);
    expect(take).toHaveBeenCalledExactlyOnceWith(null);
  });
});

describe("coseEs256Key", () => {
  it("reads the 77-byte ES256 key and refuses anything else", () => {
    expect(coseEs256Key(COSE)).not.toBeNull();
    const rs256 = Buffer.from(COSE);
    rs256[4] = 0x39;
    const zeros = Buffer.concat([COSE.subarray(0, 10), Buffer.alloc(32), COSE.subarray(42, 45)]);
    const offCurve = Buffer.from(COSE);
    offCurve.writeUInt8(offCurve.readUInt8(76) ^ 1, 76);
    for (const bad of [
      Buffer.alloc(0),
      COSE.subarray(0, 76),
      Buffer.concat([COSE, Buffer.from([0])]),
      rs256,
      Buffer.concat([zeros, Buffer.alloc(32)]),
      offCurve,
    ])
      expect(coseEs256Key(bad)).toBeNull();
    expect(verifyAssertion(build(), EXPECTED, { ...STORED, publicKey: offCurve }, ok)).toEqual(
      refused,
    );
  });
});

// DAN-840-2c: registration. The local builder lays out authenticator data as a
// key does (rpIdHash, flags, counter, AAGUID, id length, id, COSE key), so each
// case changes one part and keeps the rest valid.
type Reg = {
  client?: unknown;
  raw?: Buffer;
  flags?: number;
  count?: number;
  id?: Buffer;
  idLength?: number;
  cose?: Buffer;
  bodyId?: Buffer;
};
function reg({
  client,
  raw,
  flags = 0x45,
  count = 0,
  id,
  idLength,
  cose = COSE,
  bodyId,
}: Reg = {}) {
  const credentialId = id ?? Buffer.from("izmisljeni-kljuc-01");
  const head = Buffer.alloc(37);
  sha256(Buffer.from(RP_ID)).copy(head);
  head.writeUInt8(flags, 32);
  head.writeUInt32BE(count, 33);
  const length = Buffer.alloc(2);
  length.writeUInt16BE(idLength ?? credentialId.length);
  const clientDataJSON =
    raw ??
    Buffer.from(
      JSON.stringify(
        client ?? {
          type: "webauthn.create",
          challenge: Buffer.from(CHALLENGE).toString("base64url"),
          origin: ORIGIN,
        },
      ),
    );
  return {
    clientDataJSON,
    authenticatorData: Buffer.concat([head, Buffer.alloc(16), length, credentialId, cose]),
    credentialId: bodyId ?? credentialId,
  };
}
const regClient = (fields: Record<string, unknown>) => ({
  type: "webauthn.create",
  challenge: "x",
  origin: ORIGIN,
  ...fields,
});

describe("verifyRegistration", () => {
  it("accepts the unchanged builder and returns the id, the raw COSE key and the counter as sent", () => {
    expect(verifyRegistration(reg(), EXPECTED, ok)).toEqual({
      ok: true,
      credentialId: Buffer.from("izmisljeni-kljuc-01"),
      publicKey: COSE,
      signCount: 0,
    });
    const global = verifyRegistration(reg({ count: 41 }), EXPECTED, ok);
    expect(global.ok && global.signCount).toBe(41);
  });

  it("registers the software key, whose assertion then passes verifyAssertion", () => {
    const authenticator = createSoftwareAuthenticator({ rpId: RP_ID, origin: ORIGIN });
    const r = authenticator.register(CHALLENGE);
    const outcome = verifyRegistration(r, EXPECTED, ok);
    if (!outcome.ok) throw new Error(outcome.code);
    expect(outcome.credentialId).toEqual(r.credentialId);
    const stored = { publicKey: outcome.publicKey, signCount: outcome.signCount };
    expect(verifyAssertion(authenticator.assert(CHALLENGE), EXPECTED, stored, ok)).toEqual({
      ok: true,
      signCount: 1,
    });
  });

  it.each([
    "https://drugo.example.invalid",
    "http://ductura.example.invalid",
    "https://DUCTURA.example.invalid",
    "https://ductura.example.invalid/",
    "https://ductura.example.invalid:8443",
  ])("refuses the origin %s", (origin) => {
    expect(verifyRegistration(reg({ client: regClient({ origin }) }), EXPECTED, ok)).toEqual(
      refused,
    );
  });

  const unsortedCose = Buffer.from(COSE);
  // {3: -7, 1: 2, ...}: the same key with the first two map entries swapped.
  unsortedCose.set([0x03, 0x26, 0x01, 0x02], 1);
  const rs256 = Buffer.from(COSE);
  rs256.writeUInt8(0x39, 4);
  const offCurve = Buffer.from(COSE);
  offCurve.writeUInt8(offCurve.readUInt8(76) ^ 1, 76);
  const otherId = Buffer.from("izmisljeni-kljuc-01");
  otherId.writeUInt8(otherId.readUInt8(0) ^ 1, 0);

  it.each([
    ["type webauthn.get", { client: regClient({ type: "webauthn.get" }) }],
    ["crossOrigin true", { client: regClient({ crossOrigin: true }) }],
    ["crossOrigin as text", { client: regClient({ crossOrigin: "true" }) }],
    ["no user presence", { flags: 0x44 }],
    ["extension data", { flags: 0xc5 }],
    ["backed up without backup eligibility", { flags: 0x55 }],
    ["no AT bit on a full layout", { flags: 0x05 }],
    ["an id length of 0", { idLength: 0, id: Buffer.alloc(0) }],
    ["an id length of 1024", { id: Buffer.alloc(1024, 1) }],
    ["an id length beyond the data", { idLength: 200 }],
    ["a COSE key one byte short", { cose: COSE.subarray(0, 76) }],
    ["a byte after the COSE key", { cose: Buffer.concat([COSE, Buffer.from([0])]) }],
    ["COSE keys in another order", { cose: unsortedCose }],
    ["another algorithm", { cose: rs256 }],
    ["a point off the curve", { cose: offCurve }],
    ["another id in the body", { bodyId: otherId }],
    ["unreadable client data", { raw: Buffer.from([0xff]) }],
  ] as const)("refuses %s", (_name, change) => {
    expect(verifyRegistration(reg(change), EXPECTED, ok)).toEqual(refused);
  });

  it("refuses only 37 bytes and a key of another rpId", () => {
    const short = { ...reg(), authenticatorData: reg().authenticatorData.subarray(0, 37) };
    expect(verifyRegistration(short, EXPECTED, ok)).toEqual(refused);
    const other = createSoftwareAuthenticator({ rpId: "drugo.example.invalid", origin: ORIGIN });
    expect(verifyRegistration(other.register(CHALLENGE), EXPECTED, ok)).toEqual(refused);
  });

  it("takes the challenge exactly once, also when the client data cannot be read", () => {
    const take = vi.fn<TakeChallenge>(() => "invalid");
    expect(verifyRegistration(reg(), EXPECTED, take)).toEqual({
      ok: false,
      code: "challenge_invalid",
    });
    expect(take).toHaveBeenCalledExactlyOnceWith(Buffer.from(CHALLENGE).toString("base64url"));
    const spent = vi.fn<TakeChallenge>(() => "ok");
    expect(verifyRegistration(reg({ raw: Buffer.from([0xff]) }), EXPECTED, spent)).toEqual(refused);
    expect(spent).toHaveBeenCalledExactlyOnceWith(null);
  });
});

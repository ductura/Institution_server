import { createHash, createPublicKey, verify } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createSoftwareAuthenticator, type Assertion, type Registration } from "./index.ts";

const RP_ID = "ductura.example.invalid";
const ORIGIN = "https://ductura.example.invalid";
const CHALLENGE = Buffer.from("izmisljeni-izazov-0001");

const sha256 = (data: Uint8Array): Buffer => createHash("sha256").update(data).digest();

// A reference relying-party check, the part a server verifier must do: the
// signature under the registered key, the client data and the rpId hash, and a
// counter above the last one seen (a lower or equal one is a cloned key).
function check(
  registration: Registration,
  assertion: Assertion,
  lastSeen: number,
  origin = ORIGIN,
): string[] {
  const failures: string[] = [];
  const key = createPublicKey({ key: registration.publicKeySpki, format: "der", type: "spki" });
  const signed = Buffer.concat([assertion.authenticatorData, sha256(assertion.clientDataJSON)]);
  if (!verify("sha256", signed, key, assertion.signature)) failures.push("signature");
  const client = JSON.parse(assertion.clientDataJSON.toString("utf8")) as Record<string, unknown>;
  if (client.type !== "webauthn.get") failures.push("type");
  if (client.challenge !== CHALLENGE.toString("base64url")) failures.push("challenge");
  if (client.origin !== origin) failures.push("origin");
  if (!assertion.authenticatorData.subarray(0, 32).equals(sha256(Buffer.from(RP_ID)))) {
    failures.push("rpId");
  }
  if (assertion.authenticatorData.readUInt32BE(33) <= lastSeen) failures.push("counter");
  return failures;
}

describe("software FIDO2 authenticator", () => {
  it("registers with rpIdHash, UP|UV|AT, counter 0 and the COSE key of the SPKI", () => {
    const authenticator = createSoftwareAuthenticator({ rpId: RP_ID, origin: ORIGIN });
    const registration = authenticator.register(CHALLENGE);
    const data = registration.authenticatorData;
    expect(data.subarray(0, 32)).toEqual(sha256(Buffer.from(RP_ID)));
    expect(data[32]).toBe(0x45);
    expect(data.readUInt32BE(33)).toBe(0);
    const idLength = data.readUInt16BE(53);
    expect(data.subarray(55, 55 + idLength)).toEqual(registration.credentialId);
    expect(data.subarray(55 + idLength)).toEqual(registration.cosePublicKey);
    const jwk = registration.publicKeyJwk;
    expect(registration.cosePublicKey.subarray(10, 42)).toEqual(
      Buffer.from(jwk.x ?? "", "base64url"),
    );
    expect(registration.cosePublicKey.subarray(45)).toEqual(Buffer.from(jwk.y ?? "", "base64url"));
    const client = JSON.parse(registration.clientDataJSON.toString("utf8")) as Record<
      string,
      unknown
    >;
    expect(client).toEqual({
      type: "webauthn.create",
      challenge: CHALLENGE.toString("base64url"),
      origin: ORIGIN,
      crossOrigin: false,
    });
  });

  it("signs assertions the registered key verifies, with a rising counter", () => {
    const authenticator = createSoftwareAuthenticator({ rpId: RP_ID, origin: ORIGIN });
    const registration = authenticator.register(CHALLENGE);
    let lastSeen = 0;
    for (const expected of [1, 2, 3]) {
      const assertion = authenticator.assert(CHALLENGE);
      expect(assertion.signCount).toBe(expected);
      expect(assertion.authenticatorData[32]).toBe(0x05);
      expect(check(registration, assertion, lastSeen)).toEqual([]);
      lastSeen = assertion.signCount;
    }
  });

  it("a wrong key: the same credential signed by another key fails the signature", () => {
    const authenticator = createSoftwareAuthenticator({ rpId: RP_ID, origin: ORIGIN });
    const registration = authenticator.register(CHALLENGE);
    const impostor = authenticator.withForeignKey();
    expect(impostor.credentialId).toEqual(registration.credentialId);
    expect(check(registration, impostor.assert(CHALLENGE), 0)).toEqual(["signature"]);
  });

  it("a cloned key: the signature holds, but the clone's counter falls behind", () => {
    const original = createSoftwareAuthenticator({ rpId: RP_ID, origin: ORIGIN });
    const registration = original.register(CHALLENGE);
    const clone = original.clone();
    const first = original.assert(CHALLENGE);
    const second = original.assert(CHALLENGE);
    expect(check(registration, first, 0)).toEqual([]);
    expect(check(registration, second, first.signCount)).toEqual([]);
    const cloned = clone.assert(CHALLENGE);
    expect(cloned.signCount).toBe(1);
    expect(check(registration, cloned, second.signCount)).toEqual(["counter"]);
    // The clone keeps its own counter; the original's is untouched.
    expect(original.signCount).toBe(2);
  });

  it("a wrong origin shows in the signed client data", () => {
    const authenticator = createSoftwareAuthenticator({ rpId: RP_ID, origin: ORIGIN });
    const registration = authenticator.register(CHALLENGE);
    const assertion = authenticator.assert(CHALLENGE, { origin: "https://drugo.example.invalid" });
    expect(check(registration, assertion, 0)).toEqual(["origin"]);
  });

  it("another relying party's authenticator fails the rpId hash", () => {
    const other = createSoftwareAuthenticator({ rpId: "drugo.example.invalid", origin: ORIGIN });
    const registration = other.register(CHALLENGE);
    expect(check(registration, other.assert(CHALLENGE), 0)).toEqual(["rpId"]);
  });

  it("each authenticator has its own key and credential id", () => {
    const a = createSoftwareAuthenticator({ rpId: RP_ID, origin: ORIGIN });
    const b = createSoftwareAuthenticator({ rpId: RP_ID, origin: ORIGIN });
    expect(a.credentialId).not.toEqual(b.credentialId);
    expect(check(a.register(CHALLENGE), b.assert(CHALLENGE), 0)).toContain("signature");
  });

  it.each([
    { rpId: "", origin: ORIGIN },
    { rpId: RP_ID, origin: "" },
  ])("refuses an empty rpId or origin %j", (options) => {
    expect(() => createSoftwareAuthenticator(options)).toThrow(/required/);
  });
});

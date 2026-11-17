// DAN-840-1 (S-1E-g): the WebAuthn second factor routes, contract only. Every
// route needs an AAI@EduHr session (D-09: never a way to sign in), and the
// vectors carry the refusals the flow promises. Invented values only.
import { readFileSync } from "node:fs";

import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { CONTRACT_ONLY, ROUTES, type RouteContract } from "./index.ts";
import type { VectorFile } from "./vectors.ts";

const IDS = [
  "auth.webauthn-challenge.post",
  "auth.webauthn-registration.post",
  "auth.webauthn-assertion.post",
] as const;
type Id = (typeof IDS)[number];

const route = (id: Id): RouteContract => {
  const found = ROUTES.find((r) => r.id === id);
  if (found === undefined) throw new Error(`no route ${id}`);
  return found;
};

const vectors = (id: Id): VectorFile =>
  JSON.parse(readFileSync(new URL(`./vectors/${id}.json`, import.meta.url), "utf8")) as VectorFile;

const vector = (id: Id, name: string) => {
  const found = vectors(id).vectors.find((v) => v.name === name);
  if (found === undefined) throw new Error(`${id}: no vector ${name}`);
  return found;
};

const bodyOf = (id: Id) => {
  const body = route(id).request.body;
  if (body === undefined) throw new Error(`${id}: no body`);
  return body;
};

describe("the refusals each route promises", () => {
  it.each(IDS)("%s: without a session cookie the answer is 401 unauthorized", (id) => {
    const v = vector(id, "unauthorized");
    expect(v.request.headers?.["cookie"]).toBeUndefined();
    expect(v.response.status).toBe(401);
    expect(v.code).toBe("unauthorized");
  });

  it.each(["auth.webauthn-registration.post", "auth.webauthn-assertion.post"] as const)(
    "%s: a replayed and an expired challenge are refused, as a wrong origin in the client data",
    (id) => {
      for (const name of ["challenge-replayed", "challenge-expired"]) {
        expect(vector(id, name).response.status).toBe(400);
        expect(vector(id, name).code).toBe("challenge_invalid");
      }
      const origin = vector(id, "client-data-origin-mismatch");
      expect(origin.response.status).toBe(400);
      expect(origin.code).toBe("ceremony_invalid");
      // The request itself comes from the right site: only the signed client data is wrong.
      expect(origin.request.headers?.["origin"]).toBe("https://ductura.example.invalid");
    },
  );

  it("a decreased signature counter on the assertion is 409 counter_not_increased", () => {
    const v = vector("auth.webauthn-assertion.post", "counter-decreased");
    expect(v.response.status).toBe(409);
    expect(v.code).toBe("counter_not_increased");
  });
});

describe("every route needs a session and takes a closed body", () => {
  it.each(IDS)("%s is signed_in, a POST with JSON, and mounted (840-3f1)", (id) => {
    const r = route(id);
    expect(r.access).toBe("signed_in");
    expect(r.method).toBe("POST");
    expect(r.request.contentType).toBe("application/json");
    expect(r.errors.some((e) => e.status === 401 && e.code === "unauthorized")).toBe(true);
    expect(CONTRACT_ONLY).not.toContain(id);
  });

  const challenge = { purpose: "assertion" };
  const assertion = {
    credentialId: "a2xqdWNfMDAx",
    clientDataJSON: "eyJ0eXBlIjoid2ViYXV0aG4uZ2V0In0",
    authenticatorData: "AAAA",
    signature: "MEUCIQ",
  };
  const registration = {
    credentialId: "a2xqdWNfMDAx",
    clientDataJSON: "eyJ0eXBlIjoid2ViYXV0aG4uY3JlYXRlIn0",
    authenticatorData: "AAAA",
  };

  it("accepts the well-formed bodies", () => {
    expect(Value.Check(bodyOf("auth.webauthn-challenge.post"), challenge)).toBe(true);
    expect(Value.Check(bodyOf("auth.webauthn-challenge.post"), { purpose: "registration" })).toBe(
      true,
    );
    expect(Value.Check(bodyOf("auth.webauthn-assertion.post"), assertion)).toBe(true);
    expect(Value.Check(bodyOf("auth.webauthn-registration.post"), registration)).toBe(true);
  });

  // Classes of input the schema refuses: a field outside base64url (padding,
  // standard alphabet, space, tab, CRLF, NBSP, DEL, a trailing newline), empty,
  // too long, an unknown or inherited key, another algorithm or purpose.
  const bad = ["", "a+b", "a/b", "ab==", "a b", "a\tb", "a\r\nb", "a b", "a\u007fb", "ab\n", "ä"];
  it.each(bad)("refuses %j as a base64url field", (value) => {
    expect(
      Value.Check(bodyOf("auth.webauthn-assertion.post"), { ...assertion, signature: value }),
    ).toBe(false);
    expect(
      Value.Check(bodyOf("auth.webauthn-registration.post"), {
        ...registration,
        credentialId: value,
      }),
    ).toBe(false);
  });

  it("refuses an over-long field, unknown and inherited keys, a key in the body and other purposes", () => {
    const assertionBody = bodyOf("auth.webauthn-assertion.post");
    const registrationBody = bodyOf("auth.webauthn-registration.post");
    const challengeBody = bodyOf("auth.webauthn-challenge.post");
    expect(Value.Check(assertionBody, { ...assertion, credentialId: "A".repeat(1366) })).toBe(
      false,
    );
    expect(Value.Check(assertionBody, { ...assertion, extra: "x" })).toBe(false);
    expect(
      Value.Check(assertionBody, { ...assertion, ...(JSON.parse('{"__proto__":"x"}') as object) }),
    ).toBe(false);
    expect(Value.Check(assertionBody, { ...assertion, toString: "x" })).toBe(false);
    expect(Value.Check(assertionBody, { ...assertion, signature: undefined })).toBe(false);
    // The key comes from authenticatorData only; the body cannot name another one.
    for (const extra of [{ publicKey: "MFkw" }, { publicKeyAlgorithm: -7 }])
      expect(Value.Check(registrationBody, { ...registration, ...extra })).toBe(false);
    for (const purpose of ["login", "Registration", "", null])
      expect(Value.Check(challengeBody, { purpose })).toBe(false);
    expect(Value.Check(challengeBody, { purpose: "assertion", userId: "x" })).toBe(false);
  });
});

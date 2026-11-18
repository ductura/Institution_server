// DAN-815 c: the signer and storage of the commit route from the
// environment. The development signer never signs outside NODE_ENV
// development or test (F-020), storage exists only from
// EVIDENCE_STORAGE_DOMAINS, and plain http to loopback never in production.
// Every key, id and secret below is invented for this test.
import { createPublicKey, randomBytes, verify } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { FakeKmsClient } from "../../test-support/fake-kms/index.ts";
import { AwsKmsEd25519SigningKeyProvider, DEV_SIGNING_KEY_FILE } from "../external/keys/index.ts";
import {
  EVIDENCE_STORAGE_DOMAINS,
  InstitutionRoutedPayloadStore,
} from "../external/storage/index.ts";

import {
  ASYNC_SIGNING_FLAG,
  evidenceIngestDependencies,
  REFUSING_SIGNER,
  STORAGE_NOT_CONFIGURED,
} from "./evidence-deps.ts";

const ROOT = resolve(import.meta.dirname, "../..");
const dir = mkdtempSync(join(tmpdir(), "dan815-signer-"));
const SEED = join(dir, "seed");
writeFileSync(SEED, randomBytes(32), { mode: 0o600 });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const KEY_VAR = "EVIDENCE_S3_FAK_A_KEY_ID";
const SECRET_VAR = "EVIDENCE_S3_FAK_A_SECRET";
const INSTITUTION = "00000000-0000-4000-8000-00000000000a";
const domain = (endpoint: string) => ({
  label: "fak-a-lokalno",
  institutionId: INSTITUTION,
  endpoint,
  region: "eu-central-1",
  bucket: "ductus-fak-a",
  accessKeyIdVar: KEY_VAR,
  secretAccessKeyVar: SECRET_VAR,
  capability: {
    provider: "fake-s3",
    endpoint,
    conditionalWrite: "verified",
    checksumEcho: "verified",
    verifiedOn: "2026-10-01",
    contractTest: "unit/fake-s3",
  },
});
const storage = (endpoint: string) => ({
  [EVIDENCE_STORAGE_DOMAINS]: JSON.stringify({
    requestTimeoutMs: 5_000,
    domains: [domain(endpoint)],
  }),
  [KEY_VAR]: "izmisljeni-kljuc",
  [SECRET_VAR]: "izmisljena-tajna-kanarinac",
});
const KEY = {
  put: { institutionId: INSTITUTION, evidencePackageId: "pkg-1", segmentHash: "a".repeat(64) },
};

describe("evidenceIngestDependencies: the signer", () => {
  it.each([undefined, "", "production", "Production", "staging"])(
    "NODE_ENV %s never signs, even with a seed",
    async (nodeEnv) => {
      const { signer } = evidenceIngestDependencies(
        { NODE_ENV: nodeEnv, [DEV_SIGNING_KEY_FILE]: SEED },
        ROOT,
      );
      expect(signer).toBe(REFUSING_SIGNER);
      await expect(signer.sign(new Uint8Array(59))).rejects.toThrow();
    },
  );

  it.each(["development", "test"])(
    "NODE_ENV %s signs with the seed outside the repository",
    async (nodeEnv) => {
      const { signer } = evidenceIngestDependencies(
        { NODE_ENV: nodeEnv, [DEV_SIGNING_KEY_FILE]: SEED },
        ROOT,
      );
      const signed = await signer.sign(new Uint8Array(59));
      expect(signed).toMatchObject({ ok: true, value: { algorithm: "Ed25519" } });
    },
  );

  it("a valid seed inside the repository root is no signature, without throwing", async () => {
    // A seed the adapter would take anywhere else (32 bytes, 0600): only the root refuses it.
    const { signer } = evidenceIngestDependencies(
      { NODE_ENV: "test", [DEV_SIGNING_KEY_FILE]: SEED },
      dir,
    );
    expect(await signer.sign(new Uint8Array(59))).toMatchObject({
      ok: false,
      error: { code: "SIGNING_KEY_IN_REPOSITORY" },
    });
  });
});

// DAN-963: a KMS configuration selects the KMS signer in every NODE_ENV; the
// fake KMS comes only through the test's parameter (it is built here, under
// vitest's NODE_ENV test). An incomplete one is no signer, never the development one.
describe("evidenceIngestDependencies: the KMS signer", () => {
  const fake = new FakeKmsClient();
  const keyId = fake.createKey();
  const kms = {
    DUCTUS_KMS_PROVIDER: "aws",
    DUCTUS_KMS_KEY_ID: keyId,
    DUCTUS_KMS_REGION: "eu-central-1",
  };
  const kmsClient = () => fake;

  it("an incomplete configuration with a valid seed never signs", () => {
    const env = { NODE_ENV: "test", [DEV_SIGNING_KEY_FILE]: SEED, ...kms, DUCTUS_KMS_REGION: "" };
    expect(evidenceIngestDependencies(env, ROOT, { kmsClient }).signer).toBe(REFUSING_SIGNER);
  });

  it.each(["test", "production", undefined])(
    "a complete configuration signs with the KMS key under NODE_ENV %s",
    async (nodeEnv) => {
      const env = { NODE_ENV: nodeEnv, [DEV_SIGNING_KEY_FILE]: SEED, ...kms };
      const { signer } = evidenceIngestDependencies(env, ROOT, { kmsClient });
      expect(signer).toBeInstanceOf(AwsKmsEd25519SigningKeyProvider);
      const message = randomBytes(59);
      const signed = await signer.sign(message);
      if (!signed.ok) throw new Error(signed.error.code);
      expect(signed.value).toMatchObject({ keyId, keyVersion: keyId });
      const key = await (signer as AwsKmsEd25519SigningKeyProvider).publicVerificationKey();
      if (!key.ok) throw new Error(key.error.code);
      const publicKey = createPublicKey({
        key: Buffer.from(key.value.keyBase64Url, "base64url"),
        format: "der",
        type: "spki",
      });
      const signature = Buffer.from(signed.value.signatureBase64Url, "base64url");
      expect(verify(null, message, publicKey, signature)).toBe(true);
    },
  );
});

describe("evidenceIngestDependencies: the storage", () => {
  it.each([
    ["no configuration", {}],
    ["configuration that is not JSON", { [EVIDENCE_STORAGE_DOMAINS]: "{" }],
    [
      "a domain without its secret",
      { ...storage("https://s3.example.invalid"), [SECRET_VAR]: undefined },
    ],
  ])("%s is no storage at all, never a default bucket", async (_name, env) => {
    const { payloads } = evidenceIngestDependencies({ NODE_ENV: "development", ...env }, ROOT);
    expect(payloads).toBe(STORAGE_NOT_CONFIGURED);
    expect(await payloads.putImmutable({ ...KEY.put, canonicalPayload: "{}" })).toEqual({
      status: "unavailable",
      reason: "storage_not_configured",
    });
    expect(await payloads.storageRefFor(KEY.put)).toMatchObject({ status: "unavailable" });
    // DAN-818: a replay read is unavailable too (503 storage), never "not found".
    expect(await payloads.readImmutable(KEY.put)).toEqual({
      status: "unavailable",
      reason: "storage_not_configured",
    });
  });

  it.each(["development", "test"])(
    "plain http to loopback is storage under NODE_ENV %s",
    (nodeEnv) => {
      const local = storage("http://127.0.0.1:4190");
      expect(
        evidenceIngestDependencies({ NODE_ENV: nodeEnv, ...local }, ROOT).payloads,
      ).toBeInstanceOf(InstitutionRoutedPayloadStore);
    },
  );

  it.each([undefined, "", "production", "Production", "staging"])(
    "plain http to loopback is never storage under NODE_ENV %s (F-020 allowlist)",
    (nodeEnv) => {
      const local = storage("http://127.0.0.1:4190");
      expect(evidenceIngestDependencies({ NODE_ENV: nodeEnv, ...local }, ROOT).payloads).toBe(
        STORAGE_NOT_CONFIGURED,
      );
    },
  );

  // QA FAIL on #133 (P9): shared credentials between institutions are allowed
  // only for loopback outside production, and production is every NODE_ENV
  // outside the allowlist, not only the exact word.
  const sharedTwo = (endpoints: [string, string]) => {
    const a = domain(endpoints[0]);
    const b = {
      ...domain(endpoints[1]),
      label: "fak-b-lokalno",
      institutionId: "00000000-0000-4000-8000-00000000000b",
      bucket: "ductus-fak-b",
    };
    return {
      [EVIDENCE_STORAGE_DOMAINS]: JSON.stringify({
        requestTimeoutMs: 5_000,
        sharedCredentials: "loopback-only",
        domains: [a, b],
      }),
      [KEY_VAR]: "izmisljeni-kljuc",
      [SECRET_VAR]: "izmisljena-tajna-kanarinac",
    };
  };
  const httpsLoopback: [string, string] = ["https://127.0.0.1:9001", "https://127.0.0.1:9002"];

  it.each([undefined, "", "production", "Production", "staging"])(
    "shared credentials on https loopback are never storage under NODE_ENV %s",
    (nodeEnv) => {
      expect(
        evidenceIngestDependencies({ NODE_ENV: nodeEnv, ...sharedTwo(httpsLoopback) }, ROOT)
          .payloads,
      ).toBe(STORAGE_NOT_CONFIGURED);
    },
  );

  it.each(["development", "test"])(
    "shared credentials on loopback are storage under NODE_ENV %s",
    (nodeEnv) => {
      expect(
        evidenceIngestDependencies({ NODE_ENV: nodeEnv, ...sharedTwo(httpsLoopback) }, ROOT)
          .payloads,
      ).toBeInstanceOf(InstitutionRoutedPayloadStore);
    },
  );

  it("an https domain is storage in production", () => {
    const { payloads } = evidenceIngestDependencies(
      { NODE_ENV: "production", ...storage("https://s3.example.invalid") },
      ROOT,
    );
    expect(payloads).toBeInstanceOf(InstitutionRoutedPayloadStore);
  });
});

// DAN-821-3 (contract Ductus#1836 c.6944230363): protocol 2 only for the
// process's own value exactly "1"; anything else, or no value, keeps it off.
describe("evidenceIngestDependencies: protocol 2 (asynchronous signing)", () => {
  const flag = (env: Record<string, string | undefined>) =>
    evidenceIngestDependencies({ NODE_ENV: "test", ...env }, ROOT).asyncSigning;

  it.each([
    undefined,
    "",
    "0",
    "true",
    "TRUE",
    "yes",
    "01",
    "1.0",
    " 1",
    "1 ",
    "\t1",
    "1\n",
    "1\r\n",
    "1\u00a0",
    "1\u007f",
    "\uff11",
  ])("%j is off", (value) => {
    expect(flag({ [ASYNC_SIGNING_FLAG]: value })).toBe(false);
  });

  it("a value only inherited, from the environment's prototype or Object.prototype, is off", () => {
    const inherited = Object.create({ [ASYNC_SIGNING_FLAG]: "1" }) as Record<string, string>;
    expect(evidenceIngestDependencies(inherited, ROOT).asyncSigning).toBe(false);
    const proto = Object.prototype as Record<string, unknown>;
    proto[ASYNC_SIGNING_FLAG] = "1";
    try {
      expect(flag({})).toBe(false);
    } finally {
      delete proto[ASYNC_SIGNING_FLAG];
    }
  });

  it('the process\'s own value exactly "1" is on', () => {
    expect(flag({ [ASYNC_SIGNING_FLAG]: "1" })).toBe(true);
  });
});

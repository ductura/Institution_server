// DAN-815 c: the signer and storage of the commit route from the
// environment. The development signer never signs outside NODE_ENV
// development or test (F-020), storage exists only from
// EVIDENCE_STORAGE_DOMAINS, and plain http to loopback never in production.
// Every key, id and secret below is invented for this test.
import { createPublicKey, randomBytes, verify as nodeVerify } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { FakeKmsClient } from "../../test-support/fake-kms/index.ts";
import {
  AwsKmsEd25519SigningKeyProvider,
  DEV_SIGNING_KEY_FILE,
  PersistentDevelopmentEd25519SigningKeyProvider,
} from "../external/keys/index.ts";
import {
  EVIDENCE_STORAGE_DOMAINS,
  InstitutionRoutedPayloadStore,
  STORAGE_UNAVAILABLE,
} from "../external/storage/index.ts";

import {
  ASYNC_SIGNING_FLAG,
  evidenceIngestDependencies,
  type KmsClientFactory,
  REFUSING_SIGNER,
  STORAGE_NOT_CONFIGURED,
} from "./evidence-deps.ts";

const ROOT = resolve(import.meta.dirname, "../..");
const dir = mkdtempSync(join(tmpdir(), "dan815-signer-"));
const SEED = join(dir, "seed");
writeFileSync(SEED, randomBytes(32), { mode: 0o600 });
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());

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
  // "Development" and "test " are the rows of Ductus receipt-signer.test.ts
  // (T9): the allowlist is exact, neither case nor whitespace is folded.
  it.each([undefined, "", "production", "Production", "staging", "Development", "test "])(
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

  // Ductus receipt-signer.test.ts (T5): outside production it is the
  // persistent development signer, and with no seed configured it makes no
  // key of its own: there is no fallback to a key in memory.
  it("NODE_ENV development without a seed is the development signer with no key (T5)", async () => {
    const { signer } = evidenceIngestDependencies({ NODE_ENV: "development" }, ROOT);
    expect(signer).toBeInstanceOf(PersistentDevelopmentEd25519SigningKeyProvider);
    expect(await signer.sign(new Uint8Array(59))).toMatchObject({
      ok: false,
      error: { code: "SIGNING_KEY_NOT_CONFIGURED" },
    });
  });

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

// DAN-963: a complete DUCTUS_KMS_* configuration selects the AWS KMS signer,
// here over the fake KMS (test-support/fake-kms); an incomplete one never
// signs and never falls back to the development signer. The fake's account
// 000000000000 and every key are invented.
describe("evidenceIngestDependencies: the KMS signer (DAN-963)", () => {
  const INVENTED_KEY_UUID = "0f1e2d3c-4b5a-4978-8a6b-5c4d3e2f1a0b";
  const RECEIPT = new TextEncoder().encode('{"izmisljeni":"potvrda-963"}');
  const kmsEnv = (keyId: string) => ({
    DUCTUS_KMS_PROVIDER: "aws",
    DUCTUS_KMS_KEY_ID: keyId,
    DUCTUS_KMS_REGION: "eu-central-1",
  });
  function fakeKms(): { kms: FakeKmsClient; keyArn: string; factory: KmsClientFactory } {
    const kms = new FakeKmsClient();
    const keyArn = kms.createKey();
    return { kms, keyArn, factory: vi.fn(() => kms) };
  }

  it.each([undefined, "", "production", "staging", "development", "test"])(
    "a complete configuration signs with the KMS key under NODE_ENV %s",
    async (nodeEnv) => {
      const { keyArn, factory } = fakeKms();
      const { signer } = evidenceIngestDependencies(
        { NODE_ENV: nodeEnv, [DEV_SIGNING_KEY_FILE]: SEED, ...kmsEnv(keyArn) },
        ROOT,
        { kmsClient: factory },
      );
      // Never the development signer, even with a seed under development or test.
      expect(signer).toBeInstanceOf(AwsKmsEd25519SigningKeyProvider);
      expect(factory).toHaveBeenCalledExactlyOnceWith({
        provider: "aws",
        keyId: keyArn,
        region: "eu-central-1",
      });
      const signed = await signer.sign(RECEIPT);
      expect(signed).toMatchObject({
        ok: true,
        value: { algorithm: "Ed25519", keyId: keyArn, keyVersion: keyArn },
      });
      if (!signed.ok) throw new Error("unreachable");
      const key = await signer.publicVerificationKey();
      if (!key.ok) throw new Error("no public key");
      expect(key.value).toMatchObject({ keyId: keyArn, keyVersion: keyArn, encoding: "spki-der" });
      // The signature is the KMS key's, checked outside the adapter.
      const spki = createPublicKey({
        key: Buffer.from(key.value.keyBase64Url, "base64url"),
        format: "der",
        type: "spki",
      });
      expect(
        nodeVerify(null, RECEIPT, spki, Buffer.from(signed.value.signatureBase64Url, "base64url")),
      ).toBe(true);
      expect(await signer.verify(RECEIPT, signed.value)).toEqual({ ok: true, value: true });
    },
  );

  it.each([undefined, "", "production", "staging", "development", "test"])(
    "an incomplete configuration never signs and makes no KMS client under NODE_ENV %s",
    async (nodeEnv) => {
      const { keyArn, factory } = fakeKms();
      const full = kmsEnv(keyArn);
      const incomplete: Record<string, string>[] = [
        { DUCTUS_KMS_KEY_ID: full.DUCTUS_KMS_KEY_ID },
        { DUCTUS_KMS_PROVIDER: "aws" },
        { DUCTUS_KMS_REGION: "eu-central-1" },
        { ...full, DUCTUS_KMS_REGION: "" },
        { ...full, DUCTUS_KMS_REGION: "eu-west-1" },
        { ...full, DUCTUS_KMS_PROVIDER: "fake-kms" },
        { ...full, DUCTUS_KMS_KEY_ID: "alias/izmisljeni-kljuc" },
      ];
      for (const kms of incomplete) {
        const { signer } = evidenceIngestDependencies(
          { NODE_ENV: nodeEnv, [DEV_SIGNING_KEY_FILE]: SEED, ...kms },
          ROOT,
          { kmsClient: factory },
        );
        expect(signer).toBe(REFUSING_SIGNER);
        await expect(signer.sign(RECEIPT)).rejects.toThrow("signing_key_unavailable");
      }
      expect(factory).not.toHaveBeenCalled();
    },
  );

  it("a KMS client that cannot be made never signs", () => {
    const { keyArn } = fakeKms();
    const { signer } = evidenceIngestDependencies(
      { NODE_ENV: "production", ...kmsEnv(keyArn) },
      ROOT,
      {
        kmsClient: () => {
          throw new Error("izmisljeni-kvar");
        },
      },
    );
    expect(signer).toBe(REFUSING_SIGNER);
  });

  it("a KMS fault is a signing failure (503 signing), never a signature", async () => {
    const { kms, keyArn, factory } = fakeKms();
    const { signer } = evidenceIngestDependencies(
      { NODE_ENV: "production", ...kmsEnv(keyArn) },
      ROOT,
      { kmsClient: factory },
    );
    kms.fault = "network";
    expect(await signer.sign(RECEIPT)).toMatchObject({ ok: false });
    kms.fault = null;
    kms.deny(keyArn);
    expect(await signer.sign(RECEIPT)).toMatchObject({ ok: false });
  });

  it("an answer for another key than the configured ARN is no signature", async () => {
    // The fake resolves the configured ARN to another key, as a rotated alias would.
    const kms = new FakeKmsClient();
    const configured = `arn:aws:kms:eu-central-1:000000000000:key/${INVENTED_KEY_UUID}`;
    kms.createKey(configured);
    const { signer } = evidenceIngestDependencies(
      { NODE_ENV: "production", ...kmsEnv(configured) },
      ROOT,
      { kmsClient: () => kms },
    );
    expect(await signer.sign(RECEIPT)).toMatchObject({ ok: false });
    expect(await signer.publicVerificationKey()).toMatchObject({ ok: false });
  });

  it("without a client handed in, production makes the SDK's own client and calls nothing", () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const { signer } = evidenceIngestDependencies(
      {
        NODE_ENV: "production",
        ...kmsEnv(`arn:aws:kms:eu-central-1:000000000000:key/${INVENTED_KEY_UUID}`),
      },
      ROOT,
    );
    expect(signer).toBeInstanceOf(AwsKmsEd25519SigningKeyProvider);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("the production module never imports the fake KMS", () => {
    const source = readFileSync(resolve(ROOT, "server/http/evidence-deps.ts"), "utf8");
    expect(source).not.toMatch(/test-support|fake-kms|FakeKmsClient/u);
  });
});

describe("evidenceIngestDependencies: the storage", () => {
  it.each([
    ["no configuration", {}],
    ["configuration that is not JSON", { [EVIDENCE_STORAGE_DOMAINS]: "{" }],
    [
      "a domain without its secret",
      { ...storage("https://s3.example.invalid"), [SECRET_VAR]: undefined },
    ],
    // Ductus payload-reader.test.ts: plain http is storage only on loopback.
    ["plain http to a host that is not loopback", storage("http://s3.example.invalid")],
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

  // Ductus payload-reader.test.ts (P2): the storage built from the
  // environment never reads an institution without a domain from another one.
  it("never reads an institution without a domain from another one (P2)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetch = vi.spyOn(globalThis, "fetch");
    const { payloads } = evidenceIngestDependencies(
      { NODE_ENV: "test", ...storage("https://s3.example.invalid") },
      ROOT,
    );
    const other = { ...KEY.put, institutionId: "00000000-0000-4000-8000-00000000000b" };
    await expect(payloads.readImmutable(other)).resolves.toEqual({
      status: "unavailable",
      reason: STORAGE_UNAVAILABLE,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

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

// Ductus ingest-deps.test.ts and payload-reader.test.ts, on Ductura's form:
// the dependencies are made once per process by server.ts (Ductus memoized
// them in the factory), and a configuration value that throws is no storage.
describe("evidenceIngestDependencies: one per process", () => {
  it("server.ts makes them once and hands the same ones to commit and replay", () => {
    const source = readFileSync(resolve(ROOT, "server/server.ts"), "utf8");
    expect(source.match(/evidenceIngestDependencies\(/g)).toHaveLength(1);
    expect(source).toMatch(/const evidenceDeps = evidenceIngestDependencies\(/);
    expect(source).toMatch(/createEvidenceCommitRouteFor\([^)]*evidenceDeps\)/);
    expect(source).toMatch(/createEvidenceReplayRouteFor\([^)]*evidenceDeps\)/);
  });

  // Ductus payload-reader.test.ts handed the reader an environment whose every
  // read throws. Ductura copies the environment first ({ ...env }), so the
  // hostile value is one that throws when the storage loader uses it: the
  // fault comes from inside the loader, as in Ductus, and must be no storage.
  it("a configuration value that throws when read is no storage, never a thrown error", async () => {
    let trapped = 0;
    const hostile = new Proxy(
      {},
      {
        get: () => {
          trapped += 1;
          throw new Error("izmisljena-tajna-kanarinac");
        },
      },
    );
    const deps = evidenceIngestDependencies(
      { NODE_ENV: "test", [EVIDENCE_STORAGE_DOMAINS]: hostile as unknown as string },
      ROOT,
    );
    expect(trapped).toBeGreaterThan(0);
    expect(deps.payloads).toBe(STORAGE_NOT_CONFIGURED);
    expect(await deps.payloads.readImmutable(KEY.put)).toEqual({
      status: "unavailable",
      reason: "storage_not_configured",
    });
  });
});

// DAN-963: the KMS signer of evidence ingest. Only the SDK's KMSClient
// constructor is replaced, by the fake KMS (built here, under vitest's
// NODE_ENV test), so the production path never imports it. Checked: the
// region the client gets, the signature, the 5 s deadline (a fake clock),
// and that an incomplete configuration is no signer, never the development one.
import { createPublicKey, randomBytes, verify } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { FakeKmsClient } from "../../test-support/fake-kms/index.ts";
import { AwsKmsEd25519SigningKeyProvider, DEV_SIGNING_KEY_FILE } from "../external/keys/index.ts";

import { evidenceIngestDependencies, REFUSING_SIGNER } from "./evidence-deps.ts";
import { KMS_CALL_TIMEOUT_MS } from "./kms-signer.ts";

const sdk = vi.hoisted(() => ({ configs: [] as unknown[], client: undefined as unknown }));
// The SDK's class name is not a camelCase property, so the entry is built from a pair.
vi.mock("@aws-sdk/client-kms", async (original) => ({
  ...(await original<typeof import("@aws-sdk/client-kms")>()),
  ...Object.fromEntries([
    [
      "KMSClient",
      vi.fn(function (config: unknown) {
        sdk.configs.push(config);
        return sdk.client;
      }),
    ],
  ]),
}));

const ROOT = resolve(import.meta.dirname, "../..");
const dir = mkdtempSync(join(tmpdir(), "dan963-seed-"));
const SEED = join(dir, "seed");
writeFileSync(SEED, randomBytes(32), { mode: 0o600 });
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => vi.useRealTimers());

const fake = new FakeKmsClient();
sdk.client = fake;
const keyId = fake.createKey();
const KMS = {
  DUCTUS_KMS_PROVIDER: "aws",
  DUCTUS_KMS_KEY_ID: keyId,
  DUCTUS_KMS_REGION: "eu-central-1",
};
const withSeed = (env: object) => ({ NODE_ENV: "test", [DEV_SIGNING_KEY_FILE]: SEED, ...env });

describe("evidenceIngestDependencies: the KMS signer", () => {
  it("an incomplete configuration with a valid seed never signs", () => {
    const env = withSeed({ ...KMS, DUCTUS_KMS_REGION: "" });
    expect(evidenceIngestDependencies(env, ROOT).signer).toBe(REFUSING_SIGNER);
  });

  // Pre-check of 13713c28: the choice read the copy, where a getter had become a value.
  it("a getter the startup check refuses is no signer, even if it would return a valid key", () => {
    const env = withSeed(KMS);
    Object.defineProperty(env, "DUCTUS_KMS_KEY_ID", { enumerable: true, get: () => keyId });
    expect(evidenceIngestDependencies(env, ROOT).signer).toBe(REFUSING_SIGNER);
  });

  it.each(["test", "production", undefined])(
    "a complete configuration signs with the KMS key of its region under NODE_ENV %s",
    async (nodeEnv) => {
      sdk.configs.length = 0;
      const { signer } = evidenceIngestDependencies(withSeed({ ...KMS, NODE_ENV: nodeEnv }), ROOT);
      expect(sdk.configs).toEqual([{ region: "eu-central-1" }]);
      expect(signer).toBeInstanceOf(AwsKmsEd25519SigningKeyProvider);
      const message = randomBytes(59);
      const signed = await signer.sign(message);
      if (!signed.ok) throw new Error(signed.error.code);
      expect(signed.value).toMatchObject({ keyId, keyVersion: keyId });
      const key = await (signer as AwsKmsEd25519SigningKeyProvider).publicVerificationKey();
      if (!key.ok) throw new Error(key.error.code);
      const der = Buffer.from(key.value.keyBase64Url, "base64url");
      const publicKey = createPublicKey({ key: der, format: "der", type: "spki" });
      const signature = Buffer.from(signed.value.signatureBase64Url, "base64url");
      expect(verify(null, message, publicKey, signature)).toBe(true);
    },
  );

  it("gives up on a silent KMS after exactly 5 s", async () => {
    const { signer } = evidenceIngestDependencies(withSeed(KMS), ROOT);
    expect(KMS_CALL_TIMEOUT_MS).toBe(5_000);
    vi.useFakeTimers();
    fake.fault = "hang";
    let settled = false;
    const signed = signer.sign(new Uint8Array(59)).finally(() => (settled = true));
    await vi.advanceTimersByTimeAsync(KMS_CALL_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(signed).resolves.toMatchObject({ ok: false, error: { code: "SIGNING_TIMEOUT" } });
    fake.fault = null;
  });
});

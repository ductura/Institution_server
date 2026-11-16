// DAN-815 c: the signer and storage of the commit route from the
// environment. The development signer never signs outside NODE_ENV
// development or test (F-020), storage exists only from
// EVIDENCE_STORAGE_DOMAINS, and plain http to loopback never in production.
// Every key, id and secret below is invented for this test.
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { DEV_SIGNING_KEY_FILE } from "../external/keys/index.ts";
import {
  EVIDENCE_STORAGE_DOMAINS,
  InstitutionRoutedPayloadStore,
} from "../external/storage/index.ts";

import {
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

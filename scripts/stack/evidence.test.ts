// DAN-817 B, plan of attack ductura/server#129 (K1-K4, P2) and the conditions of
// the contract confirmation (Ductus#1836 c.6911545693): the stack's seed,
// bucket label and server environment, and that a production NODE_ENV never
// falls back to the development signer or the local S3.
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AuthConfigError, loadAuthConfig } from "../../server/external/srce-auth/index.ts";
import { loadEvidenceStorageConfig } from "../../server/external/storage/index.ts";
import {
  evidenceIngestDependencies,
  REFUSING_SIGNER,
  STORAGE_NOT_CONFIGURED,
} from "../../server/http/index.ts";
import {
  ensureBucketIdentity,
  ensureSeed,
  IDENTITY_KEY,
  newS3Credentials,
  S3_BUCKET,
  seedFile,
  serverEvidenceEnv,
  storageDomains,
} from "./evidence.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/u, "");
// Invented ids only.
const INSTITUTION = "00000000-0000-4000-8000-00000000000a";
const OTHER = "00000000-0000-4000-8000-00000000000b";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vs1-evidence-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("the signing seed (K1)", () => {
  it("lies outside the checkout when the stack directory is inside it", () => {
    const seed = seedFile(`${ROOT}/.stack/vs1`, ROOT, "/home/izmisljeni");
    expect(seed.startsWith("/home/izmisljeni/.ductura/stack-vs1-")).toBe(true);
    expect(seed.startsWith(`${ROOT}/`)).toBe(false);
    // One stack directory, one seed; another directory, another seed.
    expect(seedFile(`${ROOT}/.stack/vs1`, ROOT, "/home/izmisljeni")).toBe(seed);
    expect(seedFile(`${ROOT}/.stack/drugi`, ROOT, "/home/izmisljeni")).not.toBe(seed);
  });

  it("lies in the stack directory when that is outside the checkout", () => {
    expect(seedFile("/tmp/ductura-vs1-x/stack", ROOT, "/home/izmisljeni")).toBe(
      "/tmp/ductura-vs1-x/stack/signing-seed",
    );
  });

  it.each([[""], ["relativno"], [ROOT], [`${ROOT}/home`]])(
    "refuses HOME %j that is not absolute or lies in the checkout",
    (home) => {
      expect(() => seedFile(`${ROOT}/.stack/vs1`, ROOT, home)).toThrow(/HOME/u);
    },
  );

  it("is 32 bytes, 0600 in a 0700 directory, and never replaced", () => {
    const seed = join(dir, "a", "signing-seed");
    ensureSeed(seed);
    const first = readFileSync(seed);
    expect(first.byteLength).toBe(32);
    expect(statSync(seed).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "a")).mode & 0o777).toBe(0o700);
    ensureSeed(seed);
    expect(readFileSync(seed).equals(first)).toBe(true);
  });
});

describe("the local S3 credentials (K3, K4)", () => {
  it("are new for every run and fit the storage adapter's rules", () => {
    const one = newS3Credentials();
    const two = newS3Credentials();
    expect(one.keyId).not.toBe(two.keyId);
    expect(one.secret).not.toBe(two.secret);
    expect(one.keyId).toMatch(/^[A-Za-z0-9_-]{1,128}$/u);
    expect(one.secret).toMatch(/^[\x21-\x7e]{1,128}$/u);
  });
});

describe("the bucket's identity label (S9 on the stack)", () => {
  it("is written once and refuses another institution without changing it", () => {
    ensureBucketIdentity(dir, INSTITUTION);
    const file = join(dir, S3_BUCKET, IDENTITY_KEY);
    const label = readFileSync(file, "utf8");
    expect(JSON.parse(label)).toEqual({ institutionId: INSTITUTION, region: "us-east-1" });
    ensureBucketIdentity(dir, INSTITUTION);
    expect(() => ensureBucketIdentity(dir, OTHER)).toThrow(/another institution/u);
    expect(readFileSync(file, "utf8")).toBe(label);
  });
});

describe("the server environment of the stack", () => {
  const setup = () => {
    const seed = join(dir, "signing-seed");
    ensureSeed(seed);
    return serverEvidenceEnv({ institutionId: INSTITUTION, seed }, 4191, newS3Credentials());
  };

  it("names exactly the evidence variables, under NODE_ENV development", () => {
    const env = setup();
    expect(Object.keys(env).sort()).toEqual([
      "DUCTUS_DEV_SIGNING_KEY_FILE",
      "EVIDENCE_S3_VS1_KEY_ID",
      "EVIDENCE_S3_VS1_SECRET",
      "EVIDENCE_STORAGE_DOMAINS",
      "NODE_ENV",
    ]);
    expect(env.NODE_ENV).toBe("development");
    // The configuration names the credential variables, never their values.
    expect(env.EVIDENCE_STORAGE_DOMAINS).not.toContain(env.EVIDENCE_S3_VS1_SECRET);
    expect(env.EVIDENCE_STORAGE_DOMAINS).not.toContain(env.EVIDENCE_S3_VS1_KEY_ID);
    const config = loadEvidenceStorageConfig(env);
    expect(config.domains.map((d) => [d.label, d.endpoint, d.bucket])).toEqual([
      ["local-demo-fakultet", "http://127.0.0.1:4191", S3_BUCKET],
    ]);
  });

  it("gives the development signer and the local S3 under development", () => {
    const deps = evidenceIngestDependencies(setup(), ROOT);
    expect(deps.signer).not.toBe(REFUSING_SIGNER);
    expect(deps.payloads).not.toBe(STORAGE_NOT_CONFIGURED);
  });

  // Contract condition 2 and P2: the same variables, seed file included, under
  // a production NODE_ENV give the refusing signer and no storage (503).
  it.each([["production"], [""], [undefined], ["Production"], [" development"], ["prod"]])(
    "under NODE_ENV %j never falls back to the development signer or the local S3",
    async (nodeEnv) => {
      const env: Record<string, string | undefined> = { ...setup(), NODE_ENV: nodeEnv };
      const deps = evidenceIngestDependencies(env, ROOT);
      expect(deps.signer).toBe(REFUSING_SIGNER);
      expect(deps.payloads).toBe(STORAGE_NOT_CONFIGURED);
      await expect(deps.signer.sign(new Uint8Array([1]))).rejects.toThrow();
    },
  );

  it("under production without storage and seed answers the same", () => {
    const deps = evidenceIngestDependencies({ NODE_ENV: "production" }, ROOT);
    expect(deps.signer).toBe(REFUSING_SIGNER);
    expect(deps.payloads).toBe(STORAGE_NOT_CONFIGURED);
  });

  // Contract condition 3 (D-09): development does not give the server a login provider.
  it("gives the server no OIDC issuer, so no fake login is configured", () => {
    const env = setup();
    expect(Object.keys(env).some((name) => /OIDC|ISSUER|AUTH/u.test(name))).toBe(false);
    expect(() => loadAuthConfig(env)).toThrow(AuthConfigError);
  });

  it("refuses a seed path inside the checkout even under development", async () => {
    const inRepo = join(ROOT, "signing-seed-test");
    const env = { ...setup(), DUCTUS_DEV_SIGNING_KEY_FILE: inRepo };
    const deps = evidenceIngestDependencies(env, ROOT);
    const signed = await deps.signer.sign(new Uint8Array([1]));
    expect(signed).toMatchObject({ ok: false, error: { code: "SIGNING_KEY_IN_REPOSITORY" } });
  });
});

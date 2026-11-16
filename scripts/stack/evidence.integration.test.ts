// DAN-817 B (self-attack B1): the server's own storage adapter, built from the
// very environment the stack gives the server, writes through the stack's
// local S3. Over a real loopback socket and a temporary directory.
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { evidenceIngestDependencies, STORAGE_NOT_CONFIGURED } from "../../server/http/index.ts";
import {
  ensureBucketIdentity,
  ensureSeed,
  newS3Credentials,
  S3_BUCKET,
  S3_REGION,
  serverEvidenceEnv,
} from "./evidence.ts";
import { startLocalS3 } from "./local-s3.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/u, "");
// Invented ids only.
const INSTITUTION = "00000000-0000-4000-8000-00000000000a";

let dir: string;
let s3: Server;
let env: Record<string, string>;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "vs1-evidence-it-"));
  const storage = join(dir, "s3");
  const seed = join(dir, "signing-seed");
  ensureSeed(seed, ROOT);
  const credentials = newS3Credentials();
  ensureBucketIdentity(storage, INSTITUTION);
  s3 = await startLocalS3({
    port: 0,
    root: storage,
    bucket: S3_BUCKET,
    region: S3_REGION,
    accessKeyId: credentials.keyId,
    secretAccessKey: credentials.secret,
  });
  const port = (s3.address() as AddressInfo).port;
  env = serverEvidenceEnv({ institutionId: INSTITUTION, seed }, port, credentials);
});

afterEach(async () => {
  await new Promise((done) => s3.close(done));
  rmSync(dir, { recursive: true, force: true });
});

describe("the server's storage on the stack", () => {
  it("stores through the local S3 and finds the same object again", async () => {
    const { payloads } = evidenceIngestDependencies(env, ROOT);
    expect(payloads).not.toBe(STORAGE_NOT_CONFIGURED);
    const canonicalPayload = JSON.stringify({ tekst: "izmišljeni segment" });
    const input = {
      institutionId: INSTITUTION,
      evidencePackageId: "paket-izmisljeni-1",
      segmentHash: createHash("sha256").update(canonicalPayload).digest("hex"),
      canonicalPayload,
    };
    expect(await payloads.putImmutable(input)).toMatchObject({ status: "stored" });
    expect(await payloads.putImmutable(input)).toMatchObject({ status: "existing" });
  });

  it("signs with the stack's seed under development", async () => {
    const { signer } = evidenceIngestDependencies(env, ROOT);
    const signed = await signer.sign(new Uint8Array([1, 2, 3]));
    expect(signed).toMatchObject({ ok: true, value: { algorithm: "Ed25519" } });
  });
});

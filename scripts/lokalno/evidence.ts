// The evidence path of `pnpm lokalno` and `pnpm stog:gore` (LOK-SRV-1):
// without a receipt key and an evidence store the server opens a work with no
// receipt key, which the front refuses, and a commit answers 503. As the VS-1
// stack does (scripts/stack): a development signing seed outside the checkout,
// its public key registered through db/main/local/evidence-signing-key.sql,
// and the local S3 on loopback. Local development and CI only (D-09, F-020);
// never a migration, never production.
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import type { Server } from "node:http";
import { join } from "node:path";

import { PersistentDevelopmentEd25519SigningKeyProvider } from "../../server/external/keys/index.ts";
import {
  ensureBucketIdentity,
  newS3Credentials,
  S3_BUCKET,
  S3_REGION,
  serverEvidenceEnv,
  startLocalS3,
} from "../stack/index.ts";

/** The local S3 of `pnpm lokalno`, on loopback; not the VS-1 stack's 4191. */
export const LOCAL_S3_PORT = 8095;
/** The institution whose evidence domain gets the key (db/main/local/seed.sql). */
export const EVIDENCE_INSTITUTION = "demo-fakultet";

export type SigningKey = { keyId: string; keyVersion: string; keyBase64Url: string };

/**
 * Where the seed and the S3 objects live: under the home directory, keyed by
 * the checkout, since the signer refuses a seed inside the repository. Both
 * stay across restarts, as the database's volume does.
 */
export function evidenceDir(root: string, home: string): string {
  const id = createHash("sha256").update(root).digest("hex").slice(0, 16);
  return join(home, ".ductura", `lokalno-${id}`);
}

/**
 * The registration of db/main/local/evidence-signing-key.sql without its psql
 * parts: only its one DO block, which reads the slug and the key from the
 * transaction's `ductus_local.*` settings. The file stays the one source of
 * what is registered; a file without the block stops the stack.
 */
export function registrationBlock(sql: string): string {
  const block = /^DO \$register\$\n[\s\S]*?^\$register\$;$/mu.exec(sql)?.[0];
  if (block === undefined) throw new Error("evidence-signing-key.sql: the DO block was not found");
  return block;
}

/** The settings the DO block reads, as one parameterised statement. */
export const REGISTRATION_SETTINGS = `
SELECT pg_catalog.set_config('ductus_local.institution_slug', $1::text, true),
       pg_catalog.set_config('ductus_local.key_id', $2::text, true),
       pg_catalog.set_config('ductus_local.key_version', $3::text, true),
       pg_catalog.set_config('ductus_local.key_base64url', $4::text, true)`;

/** 32 random bytes, 0600 in a 0700 directory; an existing seed is kept. */
function ensureSeed(file: string, dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    writeFileSync(file, randomBytes(32), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (Reflect.get(error as object, "code") !== "EEXIST") throw error;
  }
}

/**
 * Makes the seed when missing and reads its public key. The signer judges the
 * seed (absolute, outside the checkout, a regular file, 0600 on POSIX).
 */
export async function developmentKey(
  root: string,
  dir: string,
): Promise<{ seed: string; key: SigningKey }> {
  const seed = join(dir, "signing-seed");
  ensureSeed(seed, dir);
  const signer = new PersistentDevelopmentEd25519SigningKeyProvider(
    { NODE_ENV: "development", DUCTUS_DEV_SIGNING_KEY_FILE: seed },
    root,
  );
  const result = await signer.publicVerificationKey();
  if (!result.ok) throw new Error(`the signing seed is not usable (${result.error.code})`);
  const { keyId, keyVersion, keyBase64Url } = result.value;
  return { seed, key: { keyId, keyVersion, keyBase64Url } };
}

/**
 * Starts the local S3 in this process with fresh credentials (only in the
 * server's environment, never on disk) and returns the server's evidence
 * variables: EVIDENCE_STORAGE_DOMAINS, the S3 key and DUCTUS_DEV_SIGNING_KEY_FILE.
 */
export async function startEvidenceStore(
  dir: string,
  institutionId: string,
  seed: string,
  port = LOCAL_S3_PORT,
): Promise<{ s3: Server; env: Record<string, string> }> {
  const s3Dir = join(dir, "s3");
  mkdirSync(s3Dir, { recursive: true, mode: 0o700 });
  ensureBucketIdentity(s3Dir, institutionId);
  const credentials = newS3Credentials();
  const s3 = await startLocalS3({
    port,
    root: await realpath(s3Dir),
    bucket: S3_BUCKET,
    region: S3_REGION,
    accessKeyId: credentials.keyId,
    secretAccessKey: credentials.secret,
  });
  return { s3, env: serverEvidenceEnv({ institutionId, seed }, port, credentials) };
}

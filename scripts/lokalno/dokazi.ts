// INT-08: the evidence storage and the receipt key of `pnpm lokalno` and
// `pnpm stog:gore`, as in scripts/stack (VS-1) but over loopback TCP, so it
// runs without psql or a socket. Local development only (D-09, F-020): the
// signing seed lies outside the checkout, its public key is registered by
// db/main/local/evidence-signing-key.sql (no new migration), and the storage
// is the local S3 of scripts/stack/local-s3.ts with credentials made for each run.
import { type ChildProcess, spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { connect } from "node:net";
import { homedir } from "node:os";

import { PersistentDevelopmentEd25519SigningKeyProvider } from "../../server/external/keys/index.ts";
import { connectLockClient } from "../../server/database/index.ts";
import {
  ensureBucketIdentity,
  ensureSeed,
  INSTITUTION_SLUG,
  newS3Credentials,
  S3_BUCKET,
  S3_REGION,
  seedFile,
} from "../stack/index.ts";
import { type AdminTarget, DATABASE, type Env, type LocalEvidence, loginUrl } from "./config.ts";
import { readFileSync } from "node:fs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SAFE_VALUE = /^[A-Za-z0-9_.+=-]{1,256}$/u;

/**
 * evidence-signing-key.sql for a plain connection: without its psql guard (the
 * `\set` … `\endif` block, which refuses TCP; the caller is the superuser of
 * DATABASE_URL, checked by adminTarget), with `\gset` (psql's statement end) replaced by `;`, and with each
 * `:'name'` replaced by its quoted value. Anything else psql alone reads stops it.
 */
export function evidenceKeyStatements(sql: string, vars: ReadonlyMap<string, string>): string {
  const noGuard = sql.replace(/^\\set ON_ERROR_STOP on\n[\s\S]*?^\\endif\n/mu, "");
  if (noGuard === sql) throw new Error("evidence-signing-key.sql: the psql guard was not found");
  const noGset = noGuard.replace(/ \\gset$/gmu, ";");
  const text = noGset.replace(/:'([a-z0-9_]+)'/gu, (_match, name: string) => {
    const value = vars.get(name);
    if (value === undefined || !SAFE_VALUE.test(value))
      throw new Error(`evidence-signing-key.sql: no safe value for ${name}`);
    return `'${value}'`;
  });
  if (/^\s*\\|\\gset|:'/mu.test(text))
    throw new Error("evidence-signing-key.sql: psql syntax is left");
  return text;
}

/** The directory of the signing seed: under $HOME, never in the checkout (the signer refuses it). */
export const seedPath = (localDir: string, root: string, home: string = homedir()): string =>
  seedFile(resolve(localDir), resolve(root), home);

/**
 * Registers the seed's public key as the receipt key of demo-fakultet's
 * evidence domain (the seed of the invented institutions has run) and returns
 * the institution's id. A second run changes no row.
 */
export async function registerEvidenceKey(
  target: AdminTarget,
  root: string,
  seed: string,
): Promise<string> {
  // NODE_ENV test only for reading the public key here; the server gets its own.
  const signer = new PersistentDevelopmentEd25519SigningKeyProvider(
    { NODE_ENV: "test", DUCTUS_DEV_SIGNING_KEY_FILE: seed },
    root,
  );
  const key = await signer.publicVerificationKey();
  if (!key.ok) throw new Error(`the signing seed is not usable (${key.error.code})`);
  const statements = evidenceKeyStatements(
    readFileSync(join(root, "db/main/local/evidence-signing-key.sql"), "utf8"),
    new Map([
      ["institution_slug", INSTITUTION_SLUG],
      ["key_id", key.value.keyId],
      ["key_version", key.value.keyVersion],
      ["key_base64url", key.value.keyBase64Url],
    ]),
  );
  const client = await connectLockClient(loginUrl(target, target.user, target.password, DATABASE), {
    attempts: 3,
    delayMs: 1000,
  });
  try {
    await client.query(statements);
    const found = await client.query<{ id: string }>(
      "SELECT id FROM identity.institution WHERE slug = $1",
      [INSTITUTION_SLUG],
    );
    const id = found.rows[0]?.id ?? "";
    if (!UUID.test(id)) throw new Error(`no institution ${INSTITUTION_SLUG} after the seed`);
    return id;
  } finally {
    await client.end();
  }
}

/** Where the local S3 keeps its objects: files in .local, so they outlive a restart. */
export const s3Root = (localDir: string): string => join(localDir, "s3");

/**
 * Everything the server needs for the evidence flow: the seed (made once,
 * outside the checkout), its key registered, the bucket labelled for the
 * institution and fresh S3 credentials. Run after `provision`.
 */
export async function prepareEvidence(options: {
  root: string;
  localDir: string;
  target: AdminTarget;
  s3Port: number;
  home?: string;
}): Promise<LocalEvidence> {
  // Without the trailing slash of a file URL: `inside` compares path prefixes.
  const root = resolve(options.root);
  const { localDir, target, s3Port } = options;
  const seed = seedPath(localDir, root, options.home);
  ensureSeed(seed, root);
  const institutionId = await registerEvidenceKey(target, root, seed);
  ensureBucketIdentity(s3Root(localDir), institutionId);
  return { institutionId, seed, s3Port, credentials: newS3Credentials() };
}

/** The local S3 as a child of `pnpm lokalno`; its credentials live only in its environment. */
export function startS3(
  root: string,
  localDir: string,
  evidence: LocalEvidence,
  base: Env,
): ChildProcess {
  return spawn(process.execPath, [join(root, "scripts", "stack", "local-s3.ts")], {
    cwd: root,
    env: {
      ...(base as NodeJS.ProcessEnv),
      NODE_ENV: "development",
      PORT: String(evidence.s3Port),
      VS1_S3_ROOT: s3Root(localDir),
      VS1_S3_BUCKET: S3_BUCKET,
      VS1_S3_REGION: S3_REGION,
      EVIDENCE_S3_VS1_KEY_ID: evidence.credentials.keyId,
      EVIDENCE_S3_VS1_SECRET: evidence.credentials.secret,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
}

/** Polls until something listens on 127.0.0.1:`port`, or `child` ends, or the time is up. */
export async function listening(port: number, child: ChildProcess, timeoutMs: number) {
  for (const end = Date.now() + timeoutMs; Date.now() < end;) {
    if (child.exitCode !== null) return false;
    const open = await new Promise<boolean>((resolve) => {
      const socket = connect({ host: "127.0.0.1", port });
      socket.once("connect", () => (socket.destroy(), resolve(true)));
      socket.once("error", () => resolve(false));
    });
    if (open) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

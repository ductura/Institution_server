// DAN-817: the evidence storage and receipt key of the VS-1 stack. Local stack
// and CI only (D-09, F-020): the development seed lies outside the checkout,
// its public key is registered over the stack's own socket by
// db/main/local/evidence-signing-key.sql, and the storage is the local S3 of
// local-s3.ts. The server reaches both only through the variables its
// production adapters read (server/http/evidence-deps.ts); none of this is
// part of dist/server.js.
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { PersistentDevelopmentEd25519SigningKeyProvider } from "../../server/external/keys/index.ts";

export const INSTITUTION_SLUG = "demo-fakultet";
export const S3_BUCKET = "ductus-evidence-demo-fakultet";
export const S3_REGION = "us-east-1";
export const STORAGE_LABEL = "local-demo-fakultet";
export const IDENTITY_KEY = "ductus-storage-identity.json";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

type Env = Record<string, string>;
export type Psql = { socket: string; port: number; env: Env };
export type EvidenceSetup = { institutionId: string; seed: string };
export type S3Credentials = { keyId: string; secret: string };

const inside = (path: string, root: string): boolean =>
  path === root || path.startsWith(`${root}/`);

/**
 * The seed file: in the stack directory when that lies outside the checkout
 * (the tests' /tmp stacks), otherwise under $HOME, keyed by the stack
 * directory, since the signer refuses a seed inside the repository.
 */
export function seedFile(stackDir: string, root: string, home: string): string {
  if (!inside(stackDir, root)) return join(stackDir, "signing-seed");
  if (!home.startsWith("/") || inside(home, root)) {
    throw new Error("HOME must be an absolute path outside the checkout for the signing seed");
  }
  const id = createHash("sha256").update(stackDir).digest("hex").slice(0, 16);
  return join(home, ".ductura", `stack-vs1-${id}`, "signing-seed");
}

/**
 * The real location of `path` even where its end does not exist yet: the
 * nearest existing ancestor with its links resolved, then the rest.
 */
function realLocation(path: string): string {
  const rest: string[] = [];
  for (let at = path; ; at = dirname(at)) {
    try {
      return join(realpathSync(at), ...rest.reverse());
    } catch (error) {
      if (Reflect.get(error as object, "code") !== "ENOENT" || dirname(at) === at) throw error;
      rest.push(basename(at));
    }
  }
}

/**
 * 32 random bytes, 0600, in a 0700 directory; an existing seed is never
 * replaced. Where the seed would land is judged through links before any
 * directory or byte is made, and again after mkdir: never inside `root`.
 */
export function ensureSeed(file: string, root: string): void {
  const repository = realpathSync(root);
  const refuse = (): never => {
    throw new Error("the signing seed would land inside the checkout (through a link?)");
  };
  if (inside(realLocation(dirname(file)), repository)) refuse();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  if (inside(realpathSync(dirname(file)), repository)) refuse();
  try {
    writeFileSync(file, randomBytes(32), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (Reflect.get(error as object, "code") !== "EEXIST") throw error;
  }
}

/** Fresh credentials for one run of the local S3; they live only in the children's environment. */
export function newS3Credentials(): S3Credentials {
  return {
    keyId: `vs1${randomBytes(9).toString("hex")}`,
    secret: randomBytes(30).toString("base64url"),
  };
}

/** psql as the cluster's `ductus` login over the stack's own socket; stdout, trimmed. */
function psql(target: Psql, args: string[], input?: string): string {
  return execFileSync(
    "psql",
    [
      "-h",
      target.socket,
      "-p",
      String(target.port),
      "-U",
      "ductus",
      "-d",
      "ductus",
      "-X",
      "-q",
      "-t",
      "-A",
      "-v",
      "ON_ERROR_STOP=1",
      ...args,
    ],
    { env: target.env, encoding: "utf8", input, stdio: ["pipe", "pipe", "inherit"] },
  ).trim();
}

/**
 * Seeds the invented institutions, registers the seed's public key as the
 * receipt key of demo-fakultet's evidence domain and returns its id. A second
 * run changes no row (seed.sql and evidence-signing-key.sql are idempotent).
 */
export async function registerEvidenceKey(
  target: Psql,
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
  psql(target, ["-f", join(root, "db/main/local/seed.sql")]);
  // psql variables, as [name, value] pairs: each value is one argv element, never a shell word.
  const vars: [string, string][] = [
    ["institution_slug", INSTITUTION_SLUG],
    ["key_id", key.value.keyId],
    ["key_version", key.value.keyVersion],
    ["key_base64url", key.value.keyBase64Url],
  ];
  psql(target, [
    ...vars.flatMap(([name, value]) => ["-v", `${name}=${value}`]),
    "-f",
    join(root, "db/main/local/evidence-signing-key.sql"),
  ]);
  const id = psql(
    target,
    ["-v", `slug=${INSTITUTION_SLUG}`],
    "SELECT id FROM identity.institution WHERE slug = :'slug';\n",
  );
  if (!UUID.test(id)) throw new Error(`no institution ${INSTITUTION_SLUG} after the seed`);
  return id;
}

/** The bucket's identity label, written once; a label for anything else stops the stack. */
export function ensureBucketIdentity(s3Root: string, institutionId: string): void {
  const bucket = join(s3Root, S3_BUCKET);
  mkdirSync(bucket, { recursive: true, mode: 0o700 });
  const file = join(bucket, IDENTITY_KEY);
  const label = JSON.stringify({ institutionId, region: S3_REGION });
  try {
    writeFileSync(file, label, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (Reflect.get(error as object, "code") !== "EEXIST") throw error;
    if (!lstatSync(file).isFile() || readFileSync(file, "utf8") !== label) {
      throw new Error("the local bucket is labelled for another institution or region");
    }
  }
}

/** EVIDENCE_STORAGE_DOMAINS for the server: one domain, on the local S3, by variable names only. */
export function storageDomains(institutionId: string, s3Port: number): string {
  const endpoint = `http://127.0.0.1:${s3Port}`;
  return JSON.stringify({
    requestTimeoutMs: 10_000,
    domains: [
      {
        label: STORAGE_LABEL,
        institutionId,
        endpoint,
        region: S3_REGION,
        bucket: S3_BUCKET,
        accessKeyIdVar: "EVIDENCE_S3_VS1_KEY_ID",
        secretAccessKeyVar: "EVIDENCE_S3_VS1_SECRET",
        // The local S3's contract test (scripts/stack/local-s3.integration.test.ts).
        capability: {
          provider: "vs1-local-s3",
          endpoint,
          conditionalWrite: "verified",
          checksumEcho: "verified",
          verifiedOn: "2026-11-16",
          contractTest: "scripts-stack-local-s3.integration",
        },
      },
    ],
  });
}

/**
 * The evidence part of the server's environment. NODE_ENV is development so
 * the development signer and plain http to the loopback S3 are allowed; the
 * stack still gives the server no OIDC issuer (D-09).
 */
export function serverEvidenceEnv(
  setup: EvidenceSetup,
  s3Port: number,
  credentials: S3Credentials,
): Env {
  return {
    NODE_ENV: "development",
    EVIDENCE_STORAGE_DOMAINS: storageDomains(setup.institutionId, s3Port),
    EVIDENCE_S3_VS1_KEY_ID: credentials.keyId,
    EVIDENCE_S3_VS1_SECRET: credentials.secret,
    DUCTUS_DEV_SIGNING_KEY_FILE: setup.seed,
  };
}

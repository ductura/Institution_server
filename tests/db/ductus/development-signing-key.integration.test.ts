import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, rmdir, symlink, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  digestEvidenceReceiptPayloadV2,
  type SignedEvidenceReceiptV2,
} from "../../../server/domain/forensics/evidence-receipt.ts";
import { verifySignedEvidenceReceiptV2 } from "../../../server/domain/forensics/evidence-receipt-verifier.ts";
import { loadGoldenVectors } from "../../../server/domain/forensics/golden-vectors/load.ts";
import { createWithActor, type WithActor } from "../../../server/database/with-actor.ts";
import { receiptKeys } from "../../../server/database/open-work.ts";
import type {
  PublicVerificationKey,
  SignatureEnvelope,
} from "../../../server/external/keys/index.ts";

import { requireLoopbackDatabaseUrl } from "../loopback-database-url.ts";
import { ciMainPsqlTarget } from "./main-seed-psql.ts";

// B-8 step 4a / DAN-83 (docs/BACKEND.md 4.13 t. 7; ADR 2026-10-11 7 (b)): a
// receipt signed by one process must verify after a restart with the key the
// registry holds. The db/local script makes the seed and registers the key;
// two separate Node processes sign; the verifier takes the key read under a
// session. Loopback only; random synthetic institutions, persons and a random
// seed in a temporary directory, all removed afterwards.
const SAFE_ADMIN_URL: string =
  process.env.DATABASE_URL ?? "postgres://ductus:ductus-local-only@127.0.0.1:54329/ductus";
requireLoopbackDatabaseUrl(
  SAFE_ADMIN_URL,
  "The signing key test runs only against a loopback database (DATABASE_URL).",
);
const run = promisify(execFile);
const ROOT = new URL("../../../", import.meta.url);
// The registration of db/main/local/evidence-signing-key.mjs on Ductura's
// signer contract (Result); see development-signing-key-registration.ts.
const SCRIPT = new URL("tests/db/ductus/development-signing-key-registration.ts", ROOT);
const SIGNER = new URL("server/external/keys/persistent-development-ed25519-signer.ts", ROOT);
const suffix = randomBytes(5).toString("hex");
const login = `it_signing_${suffix}`;
const password = randomBytes(24).toString("hex");
const people = ["own", "other"].map((name) => ({
  name,
  institutionId: randomUUID(),
  userId: randomUUID(),
  token: randomBytes(32).toString("base64url"),
  slug: `it-${name}-${suffix}`,
}));
const [own, other] = people;

const admin = new pg.Pool({ connectionString: SAFE_ADMIN_URL, max: 1 });
let appPool: pg.Pool;
let withActor: WithActor;
let dir: string;
let seedFile: string;

// The script reaches the database the way every db/local script does: psql in
// the compose postgres container or the local PostgreSQL socket in CI.
function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NODE_ENV: "test",
    DUCTUS_DEV_SIGNING_KEY_FILE: seedFile,
    ...extra,
  } as NodeJS.ProcessEnv;
}

const NATIVE_SCRIPT = `
  const { main } = await import(process.argv[1]);
  try {
    console.log(JSON.stringify(await main(process.env, process.argv.slice(3), JSON.parse(process.argv[2]))));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "failed");
    process.exitCode = 1;
  }
`;

async function registerKey(extra: Record<string, string> = {}, slug = own.slug) {
  const args = ["--institution", slug];
  const psql = ciMainPsqlTarget();
  const argv =
    psql === undefined
      ? [fileURLToPath(SCRIPT), ...args]
      : [
          "--input-type=module",
          "--eval",
          NATIVE_SCRIPT,
          SCRIPT.href,
          JSON.stringify(psql),
          ...args,
        ];
  const { stdout } = await run(process.execPath, argv, { env: env(extra) });
  return JSON.parse(stdout) as { evidenceDomainId: string; keyId: string; keyVersion: string };
}

// One fresh process: loads the signer from the seed file and signs the given
// bytes, as the web process would after a restart.
const SIGN_CHILD = `
  const { PersistentDevelopmentEd25519SigningKeyProvider: P } = await import(${JSON.stringify(SIGNER.href)});
  const out = {};
  try {
    const signer = new P(process.env, process.argv[1]);
    const signature = await signer.sign(Buffer.from(process.argv[2], "hex"));
    const key = await signer.publicVerificationKey();
    if (!signature.ok) out.fault = signature.error.code;
    else if (!key.ok) out.fault = key.error.code;
    else Object.assign(out, { signature: signature.value, key: key.value });
  } catch (error) { out.fault = error.code ?? "other"; }
  console.log(JSON.stringify(out));`;

async function signInNewProcess(message: Uint8Array, extra: Record<string, string> = {}) {
  const { stdout } = await run(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      SIGN_CHILD,
      fileURLToPath(ROOT),
      Buffer.from(message).toString("hex"),
    ],
    { env: env(extra) },
  );
  return JSON.parse(stdout) as
    { signature: SignatureEnvelope; key: PublicVerificationKey } | { fault: string };
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ductus-it-signing-"));
  // The directory does not exist yet: the script makes it.
  seedFile = join(dir, "keys", "seed");
  const ddl = await admin.query<{ ddl: string }>(
    "SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L IN ROLE ductus_app', $1::text, $2::text) AS ddl",
    [login, password],
  );
  await admin.query(ddl.rows[0].ddl);
  const client = await admin.connect();
  try {
    await client.query("BEGIN");
    for (const p of people) {
      await client.query("INSERT INTO identity.institution (id, slug) VALUES ($1, $2)", [
        p.institutionId,
        p.slug,
      ]);
      await client.query(
        `INSERT INTO identity.user_account (id, institution_id, oidc_issuer, oidc_subject, hr_edu_person_unique_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          p.userId,
          p.institutionId,
          `https://issuer-${suffix}.test`,
          `sub-${p.name}`,
          `${p.name}@${suffix}.example`,
        ],
      );
      await client.query(
        `INSERT INTO identity.session (token_hash, user_id, institution_id, expires_at)
         VALUES (sha256(convert_to($1, 'UTF8')), $2, $3, now() + interval '1 hour')`,
        [p.token, p.userId, p.institutionId],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  const url = new URL(SAFE_ADMIN_URL);
  url.username = login;
  url.password = password;
  appPool = new pg.Pool({ connectionString: url.href, max: 2 });
  withActor = createWithActor(appPool);
});

afterAll(async () => {
  await appPool?.end();
  await admin.query("BEGIN");
  await admin.query("SET LOCAL session_replication_role = replica");
  for (const p of people) {
    await admin.query("DELETE FROM evidence.signing_key WHERE institution_id = $1", [
      p.institutionId,
    ]);
    await admin.query("DELETE FROM evidence.domain WHERE institution_id = $1", [p.institutionId]);
    await admin.query("DELETE FROM identity.session WHERE user_id = $1", [p.userId]);
    await admin.query("DELETE FROM identity.user_account WHERE institution_id = $1", [
      p.institutionId,
    ]);
    await admin.query("DELETE FROM identity.institution WHERE id = $1", [p.institutionId]);
  }
  await admin.query("COMMIT");
  const drop = await admin.query<{ ddl: string }>(
    "SELECT format('DROP ROLE IF EXISTS %I', $1::text) AS ddl",
    [login],
  );
  await admin.query(drop.rows[0].ddl);
  await admin.end();
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("persistent development signing key", () => {
  it("is made and registered once; a second run changes no row and keeps the seed", async () => {
    const first = await registerKey();
    const seed = await readFile(seedFile);
    expect(seed.byteLength).toBe(32);
    expect(await registerKey()).toEqual(first);
    expect(await readFile(seedFile)).toEqual(seed);
    const rows = await admin.query(
      `SELECT k.key_id, k.key_version, k.evidence_domain_id::text AS domain, d.region, k.purpose, k.revoked_at
         FROM evidence.signing_key k JOIN evidence.domain d ON d.id = k.evidence_domain_id
        WHERE k.institution_id = $1`,
      [own.institutionId],
    );
    expect(rows.rows).toEqual([
      {
        key_id: first.keyId,
        key_version: first.keyVersion,
        domain: first.evidenceDomainId,
        region: "local",
        purpose: "receipt",
        revoked_at: null,
      },
    ]);

    // The same public key for another institution is refused as a whole: no
    // key moves and no domain is left behind.
    const moved = await registerKey({}, other.slug).then(
      () => null,
      (error: { stderr: string }) => error.stderr,
    );
    expect(moved).toContain("make a new seed file");
    const otherRows = await admin.query(
      `SELECT (SELECT count(*) FROM evidence.domain WHERE institution_id = $1)::int AS domains,
              (SELECT count(*) FROM evidence.signing_key WHERE institution_id = $1)::int AS keys`,
      [other.institutionId],
    );
    expect(otherRows.rows).toEqual([{ domains: 0, keys: 0 }]);
  });

  it("signs a receipt in one process that verifies after a restart with the key from the registry", async () => {
    const { evidenceDomainId, keyId } = await registerKey();
    const payload = { ...loadGoldenVectors().receiptV2.accepted[0].payload, evidenceDomainId };
    const digest = await digestEvidenceReceiptPayloadV2(payload);
    const before = await signInNewProcess(digest.signingInput);
    const after = await signInNewProcess(digest.signingInput);
    assert("key" in before && "key" in after);
    expect(before.key.keyId).toBe(keyId);
    expect(after).toEqual(before);

    const signed: SignedEvidenceReceiptV2 = {
      payload,
      payloadDigestSha256: digest.sha256,
      signature: after.signature,
    };
    const expectation = {
      documentId: payload.documentId,
      clientTransactionId: payload.clientTransactionId,
      revision: payload.revision,
      evidenceDomainId,
    };
    const keysFor = (token: string | null) =>
      withActor(token, (tx) => receiptKeys(tx, evidenceDomainId));
    const ownKeys = await keysFor(own.token);
    assert(ownKeys !== null);
    expect(ownKeys).toMatchObject([{ keyId, keyBase64Url: before.key.keyBase64Url }]);
    expect(await verifySignedEvidenceReceiptV2(signed, expectation, ownKeys)).toEqual({
      ok: true,
      payload,
    });

    // Another institution's session, and no session, read no key of this domain.
    for (const token of [other.token, null]) {
      expect(await keysFor(token)).toEqual([]);
    }
    expect(await verifySignedEvidenceReceiptV2(signed, expectation, [])).toEqual({
      ok: false,
      reason: "key_unknown",
    });
  });

  it("writes no seed into the repository through a link to it, also into a directory still to be made", async () => {
    const link = join(dir, "repo-link");
    await symlink(fileURLToPath(ROOT), link, process.platform === "win32" ? "junction" : "dir");
    const fresh = `it-seed-${suffix}`;
    try {
      // Also behind a ".." after a directory that does not exist (review465b):
      // written by hand, because join() would fold the ".." itself.
      const behindDotDot = [dir, "not-yet", "..", "repo-link", fresh, "seed"].join(sep);
      for (const path of [join(link, fresh, "seed"), behindDotDot]) {
        const refused = await registerKey({ DUCTUS_DEV_SIGNING_KEY_FILE: path }).then(
          () => null,
          (error: { stderr: string }) => error.stderr,
        );
        expect(refused).toMatch(/signing_key_in_repository/i);
        // Refused before mkdir: no directory in the repository, none beside it.
        expect(existsSync(fileURLToPath(new URL(fresh, ROOT)))).toBe(false);
        expect(existsSync(join(dir, "not-yet"))).toBe(false);
      }
    } finally {
      // Remove the link itself before the temporary directory is removed, so
      // no recursive removal can ever walk into the repository behind it.
      await unlink(link).catch(() => rmdir(link));
    }
  });

  it("makes no key without the seed file, and none in production (T5, T9)", async () => {
    const message = new Uint8Array(59);
    expect(
      await signInNewProcess(message, { DUCTUS_DEV_SIGNING_KEY_FILE: join(dir, "missing") }),
    ).toEqual({
      fault: "SIGNING_KEY_MISSING",
    });
    expect(await signInNewProcess(message, { NODE_ENV: "production" })).toEqual({
      fault: "signing_key_production",
    });
    const refused = await registerKey({ NODE_ENV: "production" }).then(
      () => null,
      (error: { stderr: string }) => error.stderr,
    );
    expect(refused).toContain("refused in production");
    // F-020: an empty or misspelt NODE_ENV counts as production too.
    for (const nodeEnv of ["", "Production", "staging"]) {
      expect(await signInNewProcess(message, { NODE_ENV: nodeEnv })).toEqual({
        fault: "signing_key_production",
      });
      const again = await registerKey({ NODE_ENV: nodeEnv }).then(
        () => null,
        (error: { stderr: string }) => error.stderr,
      );
      expect(again).toContain("refused in production");
    }
  });
});

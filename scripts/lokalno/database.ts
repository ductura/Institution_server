// The database steps of `pnpm lokalno`, over loopback TCP so they run on
// Windows as on Linux (no psql, no socket, no Docker). The same files and
// order as `pnpm db:up:native`: db/main/local/migrator.sql, the migrations
// through scripts/db/migrate-locked.ts (dbmate under an advisory lock), the
// local logins and the invented institutions of db/main/local/seed.sql.
// app-login.sql and auth-login.sql refuse TCP, so their two roles are stated
// here, with the same attributes and grants and the generated passwords.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { connectLockClient } from "../../server/database/index.ts";
import {
  type AdminTarget,
  DATABASE,
  type Env,
  type LocalSecrets,
  loginUrl,
  seedStatements,
} from "./config.ts";
import { registrationBlock, REGISTRATION_SETTINGS, type SigningKey } from "./evidence.ts";

type Client = Awaited<ReturnType<typeof connectLockClient>>;

/** The local logins: name, the one group role each joins, and its password. */
export function localLogins(secrets: LocalSecrets): [string, string, string][] {
  return [
    ["ductus_app_local", "ductus_app", secrets.appPassword],
    ["ductus_auth_local", "ductus_auth", secrets.authPassword],
  ];
}

async function connect(target: AdminTarget, database: string): Promise<Client> {
  const url = loginUrl(target, target.user, target.password, database);
  try {
    return await connectLockClient(url, { attempts: 3, delayMs: 1000 });
  } catch (error) {
    const code = Reflect.get(error as object, "code");
    throw new Error(
      `cannot connect to PostgreSQL on ${target.host}:${target.port} as the DATABASE_URL user (${String(code ?? "no code")})`,
    );
  }
}

async function withClient<T>(
  target: AdminTarget,
  database: string,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const client = await connect(target, database);
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Creates the database `ductus` when it is missing; the server needs PostgreSQL 16 or later. */
async function ensureDatabase(target: AdminTarget, log: (line: string) => void): Promise<void> {
  await withClient(target, "postgres", async (client) => {
    const version = await client.query<{ v: string }>("SHOW server_version_num");
    if (Number(version.rows[0]?.v) < 160000) throw new Error("PostgreSQL 16 or later is needed");
    const found = await client.query("SELECT 1 FROM pg_catalog.pg_database WHERE datname = $1", [
      DATABASE,
    ]);
    if (found.rowCount === 0) {
      log(`Creating the database ${DATABASE}.`);
      await client.query(`CREATE DATABASE ${DATABASE}`);
    }
  });
}

/** Runs scripts/db/migrate-locked.ts; resolves to its exit code. */
function migrate(root: string, url: string, env: Env): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [join(root, "scripts", "db", "migrate-locked.ts"), "--url", url],
      { cwd: root, env: env as NodeJS.ProcessEnv, stdio: "inherit", windowsHide: true },
    );
    child.once("error", () => resolve(-1));
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

const LOGIN_SQL = `
SELECT pg_catalog.format(
  'ALTER ROLE %I LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
  $1::text, $2::text) AS statement`;

/**
 * Provisions and migrates the main database: the roles of migrator.sql, every
 * migration, the two local logins and the seed. Idempotent: a second run
 * applies only new migrations and resets the logins' passwords to .local's.
 */
export async function provision(options: {
  root: string;
  target: AdminTarget;
  secrets: LocalSecrets;
  env: Env;
  log?: (line: string) => void;
}): Promise<void> {
  const { root, target, secrets, env, log = console.log } = options;
  await ensureDatabase(target, log);
  const local = (file: string): string => readFileSync(join(root, "db/main/local", file), "utf8");
  log("db/main/local/migrator.sql");
  await withClient(target, DATABASE, (client) => client.query(local("migrator.sql")));

  log("Migrations (scripts/db/migrate-locked.ts).");
  const url = loginUrl(target, target.user, target.password, DATABASE, "ductus_migrator");
  if ((await migrate(root, url, env)) !== 0) throw new Error("the migrations failed");

  await withClient(target, DATABASE, async (client) => {
    for (const [login, group, password] of localLogins(secrets)) {
      log(`Login ${login} (member of ${group}).`);
      const exists = await client.query("SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $1", [
        login,
      ]);
      if (exists.rowCount === 0) await client.query(`CREATE ROLE ${login}`);
      const { rows } = await client.query<{ statement: string }>(LOGIN_SQL, [login, password]);
      await client.query(rows[0]?.statement ?? "");
      await client.query(`GRANT ${group} TO ${login} WITH INHERIT TRUE, SET FALSE`);
    }
    log("db/main/local/seed.sql (invented institutions).");
    await client.query(seedStatements(local("seed.sql")));
  });
}

/**
 * Registers the development signing key as the receipt key of the
 * institution's evidence domain (LOK-SRV-1), with the DO block of
 * db/main/local/evidence-signing-key.sql in one transaction, and returns the
 * institution's id. A second run with the same key changes no row.
 */
export async function registerSigningKey(options: {
  root: string;
  target: AdminTarget;
  slug: string;
  key: SigningKey;
}): Promise<string> {
  const { root, target, slug, key } = options;
  const sql = readFileSync(join(root, "db/main/local/evidence-signing-key.sql"), "utf8");
  return withClient(target, DATABASE, async (client) => {
    await client.query("BEGIN");
    try {
      await client.query(REGISTRATION_SETTINGS, [
        slug,
        key.keyId,
        key.keyVersion,
        key.keyBase64Url,
      ]);
      await client.query(registrationBlock(sql));
      const { rows } = await client.query<{ id: string }>(
        "SELECT id::text AS id FROM identity.institution WHERE slug = $1",
        [slug],
      );
      await client.query("COMMIT");
      const id = rows[0]?.id;
      if (id === undefined) throw new Error(`no institution ${slug} after the seed`);
      return id;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  });
}

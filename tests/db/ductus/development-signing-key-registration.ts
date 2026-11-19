// Local stack and CI only. The registration of db/main/local/evidence-signing-key.mjs
// (Ductus db/local), step for step, on Ductura's signer contract: the copied
// script reads publicVerificationKey() as a value that throws on a seed
// fault, while Ductura's SigningKeyProvider returns a Result (docs/CODE_STYLE.md
// §8), so the script registers `undefined` (Ductus#2028 c.7018457495). The
// orchestrator kept the alignment in tests/ (c.7019455316 (d)); the script
// itself stays with the owner of db/main/local. Prints only public values.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEV_SIGNING_KEY_FILE,
  PersistentDevelopmentEd25519SigningKeyProvider,
  developmentSeedPath,
} from "../../../server/external/keys/persistent-development-ed25519-signer.ts";
import { nativePsqlTarget } from "../../../db/main/local/psql-target.ts";
// @ts-expect-error -- a plain .mjs of the local stack, without declarations.
import { registrationInvocation } from "../../../db/main/local/evidence-signing-key.mjs";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SQL_FILE = fileURLToPath(new URL("db/main/local/evidence-signing-key.sql", `file://${ROOT}`));
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

type Invocation = { command: string; args: string[]; env?: NodeJS.ProcessEnv };

function runPsql({ command, args, env }: Invocation): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      env,
      stdio: ["pipe", "pipe", "inherit"],
      windowsHide: true,
    });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
    child.once("error", () => reject(new Error("could not start psql")));
    child.once("exit", (code) =>
      code === 0 ? resolve(out.trim()) : reject(new Error("registration failed")),
    );
    createReadStream(SQL_FILE).pipe(child.stdin);
  });
}

/** The public key, or the closed code of the seed fault as a thrown message. */
async function publicKey(signer: PersistentDevelopmentEd25519SigningKeyProvider) {
  const key = await signer.publicVerificationKey();
  if (!key.ok) throw new Error(key.error.code);
  return key.value;
}

export async function main(
  env: NodeJS.ProcessEnv = process.env,
  argv: string[] = process.argv.slice(2),
  psql: unknown = undefined,
) {
  // An allowlist, as for the signer: an unset, empty or misspelt NODE_ENV counts as production (F-020).
  if (env.NODE_ENV !== "development" && env.NODE_ENV !== "test") {
    throw new Error("the development signing key is refused in production");
  }
  if (!(argv.length === 0 || (argv.length === 2 && argv[0] === "--institution"))) {
    throw new Error("the only argument is --institution <slug>");
  }
  const slug = argv.length === 0 ? "demo-fakultet" : argv[1];
  if (typeof slug !== "string" || slug.length > 64 || !SLUG.test(slug))
    throw new Error("--institution needs a slug");
  // A native target is judged before the seed is made, so a refused one writes nothing.
  if (psql !== undefined) nativePsqlTarget(psql, env);

  // The signer judges the path (set, absolute, outside the repository) before
  // anything is written, so a bad path makes no file.
  const signer = new PersistentDevelopmentEd25519SigningKeyProvider(env, ROOT);
  const first = await signer.publicVerificationKey();
  if (!first.ok && first.error.code !== "SIGNING_KEY_MISSING") throw new Error(first.error.code);
  if (!first.ok) {
    // The one path the signer judged, ".." folded, so mkdir makes nothing it did not judge.
    const path = developmentSeedPath(env[DEV_SIGNING_KEY_FILE] ?? "");
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    // Judged again where the directory now exists, before a byte is written.
    const again = await signer.publicVerificationKey();
    if (!again.ok && again.error.code !== "SIGNING_KEY_MISSING") throw new Error(again.error.code);
    await writeFile(path, randomBytes(32), { flag: "wx", mode: 0o600 }).catch((error: unknown) => {
      if (Reflect.get(error as object, "code") !== "EEXIST")
        throw new Error("the seed file could not be written");
    });
  }
  const key = await publicKey(signer);
  const evidenceDomainId = await runPsql(
    registrationInvocation(env, slug, key, psql) as Invocation,
  );
  return { evidenceDomainId, keyId: key.keyId, keyVersion: key.keyVersion };
}

// Provisions the local worker login (db/main/local/worker-login.sql) in the
// compose postgres-main container, with the password from
// DUCTUS_WORKER_LOCAL_PASSWORD. Ported from Ductus scripts/db/provision-worker.mjs
// at d52a92c3 (S-0.14, DAN-727); only the compose service name, the paths and
// the types changed.
//
//   pnpm db:provision:worker
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

export type Invocation = { command: string; args: string[]; stdinFile: string };

const root = fileURLToPath(new URL("../../", import.meta.url));
const SQL_FILE = fileURLToPath(new URL("../../db/main/local/worker-login.sql", import.meta.url));

/** Build the docker invocation; the password travels as an argv element, never through a shell. */
export function workerProvisionInvocation(env: Record<string, string | undefined>): Invocation {
  const password = env["DUCTUS_WORKER_LOCAL_PASSWORD"];
  if (typeof password !== "string" || password.length < 16) {
    throw new Error("DUCTUS_WORKER_LOCAL_PASSWORD must be set to at least 16 characters.");
  }
  return {
    command: "docker",
    args: [
      "compose",
      "exec",
      "-T",
      "postgres-main",
      "psql",
      "-U",
      "ductus",
      "-d",
      "ductus",
      "-v",
      "ON_ERROR_STOP=1",
      "-q",
      "-v",
      `worker_password=${password}`,
    ],
    stdinFile: SQL_FILE,
  };
}

function main(): void {
  let invocation: Invocation;
  try {
    invocation = workerProvisionInvocation(process.env);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "unknown error");
    process.exitCode = 1;
    return;
  }
  const child = spawn(invocation.command, invocation.args, {
    cwd: root,
    stdio: ["pipe", "inherit", "inherit"],
    windowsHide: true,
  });
  child.once("error", () => {
    console.error("Could not start docker compose.");
    process.exitCode = 1;
  });
  child.once("exit", (code) => {
    process.exitCode = code ?? 1;
  });
  createReadStream(invocation.stdinFile).pipe(child.stdin);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

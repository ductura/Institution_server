// K-3b2 / DAN-88 (#635): loads the invented K-3 course, assignment and
// enrolment (demo-k3.sql) into the local compose database. It runs after the
// seed; it can also run alone:
//
//   node db/main/local/demo-k3.ts        (after pnpm db:seed)
//
// psql runs as the compose superuser inside the postgres-main container, as
// for the other db/main/local scripts, or, for an importing caller, through a
// native psql target on the local socket (psql-target.ts); the SQL refuses any
// other target itself. A rerun changes nothing. Prints no token, code or
// identifier. Ported from Ductus db/local/demo-k3.mjs at d52a92c3 (S-0.14,
// DAN-727); only the compose service name, the paths and the types changed.
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

import { nativePsqlTarget, type Env } from "./psql-target.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SQL_FILE = fileURLToPath(new URL("./demo-k3.sql", import.meta.url));

export type Invocation = { command: string; args: string[]; env?: Env };

/** The docker invocation; every value is one argv element, never a shell. */
export const PSQL_ARGS: readonly string[] = Object.freeze([
  "compose",
  "exec",
  "-T",
  "postgres-main",
  "psql",
  "-X",
  "-q",
  "-v",
  "ON_ERROR_STOP=1",
  "-U",
  "ductus",
  "-d",
  "ductus",
]);

/** The psql invocation: docker by default, or the native target with the same options. */
export function loadInvocation(psql: unknown, env: Env = {}): Invocation {
  if (psql === undefined) return { command: "docker", args: [...PSQL_ARGS] };
  const native = nativePsqlTarget(psql, env);
  return {
    command: native.command,
    args: [...native.args, "-X", "-q", "-v", "ON_ERROR_STOP=1"],
    env: native.env,
  };
}

export function main(
  env: Env = process.env,
  argv: string[] = process.argv.slice(2),
  psql: unknown = undefined,
): Promise<void> {
  if (env["NODE_ENV"] === "production")
    return Promise.reject(new Error("K-3 demo data is refused in production"));
  // No argument: one given is refused, never ignored.
  if (argv.length !== 0) return Promise.reject(new Error("K-3 demo data takes no argument"));
  let invocation: Invocation;
  try {
    invocation = loadInvocation(psql, env);
  } catch (error) {
    return Promise.reject(
      error instanceof Error ? error : new Error("the psql target was refused"),
    );
  }
  return new Promise((resolve, reject) => {
    // psql errors name the failing step; the functions' errors carry no input
    // and the tokens are PL/pgSQL variables, which an error context does not print.
    const child = spawn(invocation.command, invocation.args, {
      cwd: ROOT,
      env: invocation.env ?? env,
      stdio: ["pipe", "ignore", "inherit"],
      windowsHide: true,
    });
    child.once("error", () => reject(new Error("could not start psql")));
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error("K-3 demo data was not loaded")),
    );
    createReadStream(SQL_FILE).pipe(child.stdin);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    () => console.log("K-3 demo course, assignment and enrolment are in place."),
    (error: unknown) => {
      console.error(
        `${error instanceof Error ? error.message : "failed"}; check that the local stack is up and seeded.`,
      );
      process.exitCode = 1;
    },
  );
}

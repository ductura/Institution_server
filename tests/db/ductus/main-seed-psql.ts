import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { nativePsqlTarget } from "../../../db/main/local/psql-target.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

export function hasCiMainSocket(): boolean {
  return process.env.GITHUB_ACTIONS === "true" && Boolean(process.env.RUNNER_TEMP);
}

/** The database job's main cluster, or the Compose main service for local tests. */
export function mainSeedPsql(input: string | Buffer, options: string[] = []): string {
  const args = ["-X", "-q", "-v", "ON_ERROR_STOP=1", ...options];
  const socket = process.env.RUNNER_TEMP;
  if (process.env.GITHUB_ACTIONS === "true" && socket) {
    const bin = process.env.PGBIN;
    const target = nativePsqlTarget(
      {
        command: bin ? join(bin, "psql") : "psql",
        args: ["-h", socket, "-p", "54329", "-U", "ductus", "-d", "ductus"],
      },
      process.env,
    );
    return execFileSync(target.command, [...target.args, ...args], {
      cwd: ROOT,
      env: target.env,
      input,
      encoding: "utf8",
    });
  }
  return execFileSync(
    "docker",
    ["compose", "exec", "-T", "postgres-main", "psql", "-U", "ductus", "-d", "ductus", ...args],
    { cwd: ROOT, input, encoding: "utf8" },
  );
}

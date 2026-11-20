import { execFileSync } from "node:child_process";
import { join } from "node:path";

import { nativePsqlTarget } from "../../../db/main/local/index.ts";

import { requireLoopbackDatabaseUrl } from "./loopback-database-url.ts";

export function localPsqlTarget(databaseUrl: string) {
  const url = new URL(requireLoopbackDatabaseUrl(databaseUrl, "DATABASE_URL"));
  const socket = process.env.DUCTUS_NATIVE_PGSOCKET;
  if (!socket || url.username !== "ductus" || url.pathname !== "/ductus") {
    throw new Error("Expected the native test database socket");
  }
  const bin = process.env.PGBIN;
  return nativePsqlTarget(
    {
      command: bin ? join(bin, "psql") : "psql",
      args: ["-h", socket, "-p", url.port || "5432", "-U", "ductus", "-d", "ductus"],
    },
    process.env,
  );
}

export function runLocalSql(databaseUrl: string, input: string): string {
  const { command, args, env } = localPsqlTarget(databaseUrl);
  return execFileSync(command, [...args, "-X", "-qAt", "-v", "ON_ERROR_STOP=1"], {
    env,
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
}

export function localScriptArgs(script: string, databaseUrl: string, args: string[]): string[] {
  const { command, args: psqlArgs } = localPsqlTarget(databaseUrl);
  const target = JSON.stringify({ command, args: psqlArgs });
  return [
    "--input-type=module",
    "-e",
    `import { main } from ${JSON.stringify(script)};
    try {
      const value = await main(process.env, process.argv.slice(1), ${target});
      console.log(typeof value === "string" ? value : JSON.stringify(value));
    } catch (error) {
      console.error(error instanceof Error ? error.message : "failed");
      process.exitCode = 1;
    }`,
    "--",
    ...args,
  ];
}

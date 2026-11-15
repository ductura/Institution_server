// DAN-759, D-09: run as a script, the stack refuses a production-like setting
// before it starts anything, and none of it reaches the server build.
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { buildServer } from "../build/index.ts";
import { commandLine, portFree, type StackState, startDetached } from "./index.ts";
import { down, LOCK, up } from "./vs1.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SCRIPT = join(ROOT, "scripts/stack/vs1.ts");
const STATE = join(ROOT, ".stack/vs1/state.json");
const dir = mkdtempSync(join(tmpdir(), "ductura-vs1-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// Ports no other test uses, so "nothing listens" means the stack started nothing.
const PORTS = { VS1_POSTGRES_PORT: "54397", VS1_SERVER_PORT: "4197", VS1_OIDC_PORT: "4297" };

function run(
  args: string[],
  env: Record<string, string>,
): { status: number | null; stderr: string } {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: dir,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", HOME: dir, ...PORTS, ...env },
  });
  return { status: result.status, stderr: result.stderr };
}

describe("pnpm stack:vs1 refuses before it starts anything", () => {
  const hadState = existsSync(STATE);

  it.each([
    [["up", "--env", "production"], {}, /only as local or ci/u],
    [["up", "--env", "staging"], {}, /only as local or ci/u],
    [["up", "--env", "ci", "--env", "production"], {}, /usage/u],
    [["up"], { NODE_ENV: "production" }, /fake OIDC/u],
    [["up", "--env", "ci"], { NODE_ENV: "production" }, /fake OIDC/u],
    [["up", "--env", "local"], { NODE_ENV: "staging" }, /fake OIDC/u],
    [["up"], { VS1_SERVER_PORT: "3000" }, /3000-3004/u],
    [["up"], { VS1_OIDC_PORT: "3004" }, /3000-3004/u],
  ])("%j with %j", async (args, env, message) => {
    const result = run(args, env);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(message);
    for (const port of Object.values(PORTS)) expect(await portFree(Number(port))).toBe(true);
    expect(existsSync(STATE)).toBe(hadState);
  });
});

describe("pnpm stack:vs1 down without a state", () => {
  it("still reports something answering on a port of the stack", async () => {
    // A running local stack would be stopped by this test: fail instead.
    expect(existsSync(STATE), "stop the local VS-1 stack before the tests").toBe(false);
    const orphan = createServer();
    await new Promise<void>((resolve) =>
      orphan.listen(Number(PORTS.VS1_SERVER_PORT), "127.0.0.1", resolve),
    );
    try {
      const result = run(["down"], {});
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/port 4197 \(server\) still answers/u);
    } finally {
      await new Promise<void>((resolve) => orphan.close(() => resolve()));
    }
    expect(run(["down"], {}).status).toBe(0);
  });

  it("goes on to PostgreSQL and the ports when state.json holds {}", () => {
    expect(existsSync(STATE), "stop the local VS-1 stack before the tests").toBe(false);
    mkdirSync(dirname(STATE), { recursive: true });
    writeFileSync(STATE, "{}");
    const result = run(["down"], {});
    expect(result.stderr).toMatch(/state\.json is unreadable/u);
    expect(result.status).toBe(0);
    expect(existsSync(STATE)).toBe(false);
  });
});

describe("down with the state of a failed up", () => {
  it("stops a process known only from memory, as the rollback of up passes it", async () => {
    expect(existsSync(STATE), "stop the local VS-1 stack before the tests").toBe(false);
    const args = ["-e", "setTimeout(() => {}, 60000)"];
    const pid = await startDetached(process.execPath, args, {
      cwd: dir,
      env: { PATH: process.env.PATH ?? "" },
      log: join(dir, "child.log"),
    });
    const marker = [process.execPath, ...args].join(" ");
    expect(commandLine(pid)).toBe(marker);
    const state: StackState = {
      env: "ci",
      startedAt: new Date().toISOString(),
      repo: { sha: "0".repeat(40), dirty: false },
      versions: {},
      serverBuildSha256: "",
      ports: { postgres: 54397, server: 4197, oidc: 4297 },
      processes: { server: { pid, marker } },
      pgdata: join(dir, "pgdata"),
    };
    expect(await down(state)).toBe(true);
    expect(commandLine(pid)).toBeNull();
  }, 30_000);
});

describe("up while another up holds the lock", () => {
  it("refuses with the manual recovery, and touches neither the state nor the cluster", async () => {
    expect(existsSync(STATE), "stop the local VS-1 stack before the tests").toBe(false);
    mkdirSync(dirname(LOCK), { recursive: true });
    writeFileSync(LOCK, "");
    try {
      await expect(
        up({ env: "ci", ports: { postgres: 54397, server: 4197, oidc: 4297 } }),
      ).rejects.toThrow(/up\.lock exists.*pnpm stack:vs1 down, then delete the lock by hand/u);
      expect(existsSync(LOCK)).toBe(true);
      expect(existsSync(STATE)).toBe(false);
      for (const port of [54397, 4197, 4297]) expect(await portFree(port)).toBe(true);
    } finally {
      rmSync(LOCK, { force: true });
    }
  });

  it("refuses through the script as well, and leaves the lock", () => {
    mkdirSync(dirname(LOCK), { recursive: true });
    writeFileSync(LOCK, "");
    try {
      const result = run(["up", "--env", "ci"], {});
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/up\.lock exists/u);
      expect(existsSync(LOCK)).toBe(true);
    } finally {
      rmSync(LOCK, { force: true });
    }
  });
});

describe("down with a leftover postmaster.pid", () => {
  it("leaves a reused pid alone even when its arguments carry -D <pgdata>", async () => {
    expect(existsSync(STATE), "stop the local VS-1 stack before the tests").toBe(false);
    const pgdata = join(ROOT, ".stack/vs1/pgdata");
    expect(existsSync(pgdata), "remove the local .stack/vs1/pgdata before the tests").toBe(false);
    const args = ["-e", "setTimeout(() => {}, 60000)", "--", "-D", pgdata, "extra"];
    const pid = await startDetached(process.execPath, args, {
      cwd: dir,
      env: { PATH: process.env.PATH ?? "" },
      log: join(dir, "foreign.log"),
    });
    try {
      mkdirSync(pgdata, { recursive: true });
      writeFileSync(join(pgdata, "postmaster.pid"), `${pid}\n${pgdata}\n0\n54397\n`);
      const result = run(["down"], {});
      expect(result.stderr).toMatch(/postmaster\.pid is not ours/u);
      expect(result.status).toBe(0);
      expect(commandLine(pid)).toContain(`-D ${pgdata}`);
    } finally {
      process.kill(-pid, "SIGKILL");
      rmSync(pgdata, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("the server build", () => {
  it("bundles neither the stack nor the fake provider", async () => {
    const outfile = join(dir, "server.js");
    await buildServer(ROOT, outfile);
    const bundle = readFileSync(outfile, "utf8");
    expect(bundle).not.toMatch(/scripts\/stack|test-fakes|demo prijava/u);
  }, 60_000);
});

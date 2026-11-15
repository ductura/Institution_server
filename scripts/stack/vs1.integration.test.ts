// DAN-759, D-09: run as a script, the stack refuses a production-like setting
// before it starts anything, and none of it reaches the server build.
import { spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { buildServer } from "../build/index.ts";
import { commandLine, portFree, type StackState, startDetached } from "./index.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SCRIPT = join(ROOT, "scripts/stack/vs1.ts");
// /tmp: the one temp root the stack accepts (TMPDIR is the caller's).
const dir = mkdtempSync(join("/tmp", "ductura-vs1-"));
// A stack directory of its own, never the developer's .stack/vs1 (its pgdata
// survives down on purpose); set before vs1.ts is loaded, and for the script.
const STACK = join(dir, "stack");
const STATE = join(STACK, "state.json");
const PGDATA = join(STACK, "pgdata");
process.env.VS1_STACK_DIR = STACK;
const { down, LOCK, oidcEnv, status, up } = await import("./vs1.ts");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// Ports no other test uses, so "nothing listens" means the stack started nothing.
const PORTS = { VS1_POSTGRES_PORT: "54397", VS1_SERVER_PORT: "4197", VS1_OIDC_PORT: "4297" };

function run(
  args: string[],
  env: Record<string, string>,
): { status: number | null; stderr: string; stdout: string } {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: dir,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", HOME: dir, VS1_STACK_DIR: STACK, ...PORTS, ...env },
  });
  return { status: result.status, stderr: result.stderr, stdout: result.stdout };
}

describe("the tests' own stack directory", () => {
  it("is a temporary one, so a developer's .stack/vs1 (and its pgdata) never matters", () => {
    expect(LOCK).toBe(join(STACK, "up.lock"));
    expect(STACK.startsWith(join(ROOT, ".stack"))).toBe(false);
  });
});

describe("pnpm stack:vs1 refuses before it starts anything", () => {
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
    expect(existsSync(STATE)).toBe(false);
  });
});

describe("pnpm stack:vs1 down without a state", () => {
  it("still reports something answering on a port of the stack", async () => {
    // A running local stack would be stopped by this test: fail instead.
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
      repos: { server: { sha: "0".repeat(40), dirty: false }, preloader: null, web: null },
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
    const pgdata = PGDATA;
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

// DAN-787: status only reads; the fake provider gets a fixed environment.
const sleeper = async (log: string): Promise<{ pid: number; marker: string }> => {
  const args = ["-e", "setTimeout(() => {}, 60000)"];
  const pid = await startDetached(process.execPath, args, {
    cwd: dir,
    env: { PATH: process.env.PATH ?? "" },
    log: join(dir, log),
  });
  return { pid, marker: [process.execPath, ...args].join(" ") };
};

function stateWith(processes: StackState["processes"], server = 4197): StackState {
  return {
    env: "ci",
    startedAt: "2026-01-01T00:00:00.000Z",
    repos: { server: { sha: "a".repeat(40), dirty: false }, preloader: null, web: null },
    versions: { node: "v24.0.0", postgres: "17.2" },
    serverBuildSha256: "0".repeat(64),
    ports: { postgres: 54397, server, oidc: 4297 },
    processes,
    pgdata: PGDATA,
  };
}

/** Bytes and mtime of each file, to show a command left them as they were. */
const snapshot = (files: string[]): string[] =>
  files.map((file) =>
    existsSync(file) ? `${statSync(file).mtimeMs}:${readFileSync(file, "hex")}` : "absent",
  );

describe("pnpm stack:vs1 status", () => {
  it("says not running and exits 1 without creating the stack directory", () => {
    const fresh = join(dir, "never-created");
    const result = run(["status"], { VS1_STACK_DIR: fresh });
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/not running/u);
    expect(existsSync(fresh)).toBe(false);
  });

  it("calls a broken state unreadable, exits 1 and leaves it and the lock as they were", () => {
    mkdirSync(STACK, { recursive: true });
    writeFileSync(STATE, "{}");
    writeFileSync(LOCK, "held");
    const before = snapshot([STATE, LOCK]);
    try {
      const result = run(["status"], {});
      expect(result.status).toBe(1);
      expect(result.stdout).toMatch(/state\.json is unreadable/u);
      expect(result.stdout).toMatch(/up\.lock present, not touched/u);
      expect(snapshot([STATE, LOCK])).toEqual(before);
    } finally {
      rmSync(STATE, { force: true });
      rmSync(LOCK, { force: true });
    }
  });

  it("asks nothing on a port 3000-3004 a state names", async () => {
    mkdirSync(STACK, { recursive: true });
    writeFileSync(STATE, JSON.stringify(stateWith({}, 3000)));
    const asked: string[] = [];
    const get = (async (url: string) => {
      asked.push(url);
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    try {
      expect(await status(get)).toBe(false);
      expect(asked).toEqual([]);
    } finally {
      rmSync(STATE, { force: true });
    }
  });

  it("names a pid that is not ours, asks it nothing and changes nothing", async () => {
    const foreign = await sleeper("status-foreign.log");
    mkdirSync(STACK, { recursive: true });
    const state = stateWith({ server: { pid: foreign.pid, marker: "/elsewhere/dist/server.js" } });
    writeFileSync(STATE, JSON.stringify(state));
    const before = snapshot([STATE, LOCK]);
    const asked: string[] = [];
    const get = (async (url: string) => (asked.push(url), new Response())) as typeof fetch;
    try {
      expect(await status(get)).toBe(false);
      expect(asked).toEqual([]);
      expect(snapshot([STATE, LOCK])).toEqual(before);
      expect(commandLine(foreign.pid)).toBe(foreign.marker);
      const result = run(["status"], {});
      expect(result.status).toBe(1);
      expect(result.stdout).toMatch(new RegExp(`pid ${foreign.pid} not ours or gone`, "u"));
      expect(result.stdout).toMatch(/preloader: not attached; web: not attached/u);
      expect(result.stdout).toMatch(/postgres 17\.2/u);
    } finally {
      process.kill(-foreign.pid, "SIGKILL");
      rmSync(STATE, { force: true });
    }
  }, 30_000);

  it("asks a process of the stack only when that very pid listens on its port", async () => {
    // Ours by marker, but listening nowhere: no request goes out.
    const ours = await sleeper("status-ours.log");
    mkdirSync(STACK, { recursive: true });
    writeFileSync(STATE, JSON.stringify(stateWith({ server: ours, oidc: ours })));
    const asked: string[] = [];
    const get = (async (url: string) => (asked.push(url), new Response())) as typeof fetch;
    try {
      expect(await status(get)).toBe(false);
      expect(asked).toEqual([]);
    } finally {
      process.kill(-ours.pid, "SIGKILL");
      rmSync(STATE, { force: true });
    }
  }, 30_000);
});

describe("status after the adversarial pass", () => {
  const listen = (server: Server): Promise<number> =>
    new Promise((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)),
    );

  it("follows no redirect: only the recorded port is asked", async () => {
    let sinkHits = 0;
    const sink = createServer((_, res) => (sinkHits++, res.end("ok")));
    const sinkPort = await listen(sink);
    const redirect = createServer((_, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${sinkPort}/` }).end();
    });
    const port = await listen(redirect);
    // This test process listens on the port, so it is "the server" of the state.
    const self = { pid: process.pid, marker: commandLine(process.pid) ?? "" };
    mkdirSync(STACK, { recursive: true });
    writeFileSync(STATE, JSON.stringify(stateWith({ server: self }, port)));
    try {
      expect(await status()).toBe(false);
      expect(sinkHits).toBe(0);
    } finally {
      rmSync(STATE, { force: true });
      await new Promise((resolve) => redirect.close(resolve));
      await new Promise((resolve) => sink.close(resolve));
    }
  });

  it("prints no control character from the state", () => {
    mkdirSync(STACK, { recursive: true });
    const state = { ...stateWith({}), startedAt: "\u001b[31m\nFAKE line" };
    writeFileSync(STATE, JSON.stringify(state));
    try {
      const result = run(["status"], {});
      expect(result.stdout).not.toContain("\u001b");
      expect(result.stdout).not.toMatch(/^FAKE/mu);
    } finally {
      rmSync(STATE, { force: true });
    }
  });
});

describe("up refuses before it changes anything", () => {
  it("leaves the target of a linked stack directory alone", () => {
    const target = join(dir, "target");
    mkdirSync(target, { mode: 0o755 });
    symlinkSync(target, join(dir, "linked"));
    const result = run(["up", "--env", "ci"], { VS1_STACK_DIR: join(dir, "linked") });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/not a directory of this user \(or is a link\)/u);
    expect(statSync(target).mode & 0o777).toBe(0o755);
    expect(existsSync(join(target, "up.lock"))).toBe(false);
  });

  it("leaves the target alone when the linked path ends in / (QA c.6900522385)", () => {
    const target = join(dir, "target-slash");
    mkdirSync(target, { mode: 0o755 });
    symlinkSync(target, join(dir, "linked-slash"));
    const result = run(["up", "--env", "ci"], { VS1_STACK_DIR: `${join(dir, "linked-slash")}/` });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/stack directory/u);
    expect(statSync(target).mode & 0o777).toBe(0o755);
    expect(existsSync(join(target, "up.lock"))).toBe(false);
  });
});

describe("a stack directory outside .stack/ and the temp dir", () => {
  it("is refused even when TMPDIR names it", () => {
    const tmp = Object.fromEntries([["TMPDIR", "/etc"]]);
    const result = run(["status"], { ...tmp, VS1_STACK_DIR: "/etc/ductura-vs1" });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/stack directory/u);
  });

  it.each([["up", "--env", "ci"], ["down"], ["status"]])(
    "stops %s before it reads or writes",
    (...args) => {
      const result = run(args, { VS1_STACK_DIR: "/etc/ductura-vs1" });
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/stack directory/u);
      expect(existsSync("/etc/ductura-vs1")).toBe(false);
    },
  );
});

describe("the fake OIDC provider of the stack (D-09)", () => {
  it("gets NODE_ENV=test, loopback addresses of this stack, and nothing of the caller", () => {
    process.env.DUCTURA_PROBE_SECRET = "x";
    try {
      const env = oidcEnv({ env: "ci", ports: { postgres: 54397, server: 4197, oidc: 4297 } });
      expect(Object.keys(env).sort()).toEqual(
        [
          "BACKCHANNEL_LOGOUT_URI",
          "HOME",
          "ISSUER",
          "NODE_ENV",
          "PATH",
          "PORT",
          "POST_LOGOUT_REDIRECT_URI",
          "REDIRECT_URI",
        ].sort(),
      );
      expect(env.NODE_ENV).toBe("test");
      expect(env.ISSUER).toBe("http://127.0.0.1:4297");
      for (const key of ["REDIRECT_URI", "POST_LOGOUT_REDIRECT_URI", "BACKCHANNEL_LOGOUT_URI"])
        expect(env[key]).toMatch(/^http:\/\/127\.0\.0\.1:4197\//u);
      expect(JSON.stringify(env)).not.toMatch(/:300[0-4]/u);
    } finally {
      delete process.env.DUCTURA_PROBE_SECRET;
    }
  });

  it("is stopped by down only while it runs the recorded command", async () => {
    const oidc = await sleeper("oidc.log");
    const foreign = await sleeper("foreign-oidc.log");
    try {
      const state = stateWith({ oidc });
      expect(await down(state)).toBe(true);
      expect(commandLine(oidc.pid)).toBeNull();
      const wrong = stateWith({ oidc: { pid: foreign.pid, marker: "node elsewhere.ts" } });
      expect(await down(wrong)).toBe(true);
      expect(commandLine(foreign.pid)).toBe(foreign.marker);
    } finally {
      process.kill(-foreign.pid, "SIGKILL");
    }
  }, 30_000);
});

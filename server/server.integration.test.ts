// The real process of dist/server.js (S-1B-a, DAN-775): built with the same
// function as `pnpm build` into a temporary folder and started there, away
// from node_modules, so the one file is all it needs. A minimal environment of
// invented values; stopped with SIGTERM. No Docker: the database host is
// .invalid and nothing may connect to it at startup.
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildServer } from "../scripts/build/index.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CANARY = "invented-canary-7f3a";
const DATABASE_URL = `postgres://app:${CANARY}@db.invalid:5432/ductura`;
const VECTOR = JSON.parse(
  readFileSync(join(ROOT, "server/contracts/vectors/platform.health.get.json"), "utf8"),
) as {
  vectors: { name: string; response: { status: number; contentType: string; body: unknown } }[];
};

type Started = {
  child: ChildProcess;
  stdout: string[];
  stderr: string[];
  exit: Promise<number | null>;
};

let dir: string;
let outfile: string;
const children: ChildProcess[] = [];

function run(env: Record<string, string>): Started {
  // No inherited variables: only what the case names (and PATH for node).
  const child = spawn(process.execPath, [outfile], {
    cwd: dir,
    env: { PATH: process.env.PATH ?? "", OIDC_CLIENT_SECRET: CANARY, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  const stdout: string[] = [];
  const stderr: string[] = [];
  child.stdout?.on("data", (chunk: Buffer) => stdout.push(String(chunk)));
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(String(chunk)));
  const exit = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  return { child, stdout, stderr, exit };
}

async function listening(started: Started): Promise<number> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const line = started.stdout
      .join("")
      .split("\n")
      .find((l) => l.includes("server.listening"));
    if (line !== undefined) return (JSON.parse(line) as { port: number }).port;
    if (started.child.exitCode !== null) throw new Error(`exited: ${started.stderr.join("")}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("server did not start");
}

const start = async (env: Record<string, string> = {}): Promise<[Started, number]> => {
  const started = run({ PORT: "0", APP_DATABASE_URL: DATABASE_URL, ...env });
  return [started, await listening(started)];
};
const url = (port: number, path: string): string => `http://127.0.0.1:${port}${path}`;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "ductura-server-"));
  outfile = join(dir, "server.js");
  await buildServer(ROOT, outfile);
}, 60_000);

afterAll(() => {
  for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
});

describe("dist/server.js", () => {
  it("answers health as its contract vector, says nothing else and stops on SIGTERM", async () => {
    const [server, port] = await start();
    const response = await fetch(url(port, "/api/v1/health"), {
      headers: { cookie: "__Host-session=invented", authorization: "Bearer invented" },
    });
    const alive = VECTOR.vectors.find((v) => v.name === "alive");
    expect(response.status).toBe(alive?.response.status);
    expect(response.headers.get("content-type")).toMatch(/^application\/json(;|$)/u);
    expect(await response.json()).toEqual(alive?.response.body);
    expect(response.headers.get("cache-control")).toBe("no-store");
    // Only transport headers besides the two above: no server, version or host.
    const ALLOWED = [
      "cache-control",
      "connection",
      "content-length",
      "content-type",
      "date",
      "keep-alive",
      "transfer-encoding",
    ];
    expect([...response.headers.keys()].filter((name) => !ALLOWED.includes(name))).toEqual([]);

    server.child.kill("SIGTERM");
    await server.exit;
    await expect(fetch(url(port, "/api/v1/health"))).rejects.toThrow();
    const output = server.stdout.join("") + server.stderr.join("");
    expect(output).not.toContain(CANARY);
    expect(server.stderr.join("")).toBe("");
  }, 20_000);

  it("refuses an unknown path, another method and a trailing slash in the contract format", async () => {
    const [server, port] = await start();
    const unknown = await fetch(url(port, "/api/v1/nope?x=1"));
    expect([unknown.status, await unknown.json()]).toEqual([404, { error: "not_found" }]);
    const slash = await fetch(url(port, "/api/v1/health/"));
    expect(slash.status).toBe(404);
    const post = await fetch(url(port, "/api/v1/health"), { method: "POST" });
    expect([post.status, post.headers.get("allow"), await post.json()]).toEqual([
      405,
      "GET",
      { error: "method_not_allowed" },
    ]);
    const head = await fetch(url(port, "/api/v1/health"), { method: "HEAD" });
    expect(head.status).toBe(405);
    server.child.kill("SIGTERM");
    await server.exit;
  }, 20_000);

  it.each([
    ["no APP_DATABASE_URL", { APP_DATABASE_URL: "" }, "APP_DATABASE_URL is not set"],
    [
      "a foreign URL",
      { APP_DATABASE_URL: `mysql://u:${CANARY}@db.invalid/x` },
      "APP_DATABASE_URL is not a postgres URL",
    ],
    ["a word as PORT", { PORT: `abc${CANARY}` }, "PORT is not a port number"],
    ["a PORT above 65535", { PORT: "70000" }, "PORT is not a port number"],
    ["an empty HOST", { HOST: "" }, "HOST is empty or has spaces"],
  ])(
    "does not start with %s and names the variable, never the value",
    async (_, env, problem) => {
      const started = run({ PORT: "0", APP_DATABASE_URL: DATABASE_URL, ...env });
      expect(await started.exit).toBe(1);
      const stderr = started.stderr.join("");
      expect(stderr).toContain(`startup refused: ${problem}`);
      expect(stderr + started.stdout.join("")).not.toContain(CANARY);
      expect(started.stdout.join("")).not.toContain("server.listening");
    },
    20_000,
  );

  it("a second process on a taken port exits 1 and the first keeps answering", async () => {
    const [first, port] = await start();
    const second = run({ PORT: String(port), APP_DATABASE_URL: DATABASE_URL });
    expect(await second.exit).toBe(1);
    expect(second.stderr.join("")).toBe("listen failed: EADDRINUSE\n");
    expect((await fetch(url(port, "/api/v1/health"))).status).toBe(200);
    first.child.kill("SIGTERM");
    await first.exit;
  }, 20_000);
});

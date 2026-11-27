// The worker process over a real process (F4-PM2-R01B, D-71, D-102):
// `node server/worker-main.ts`. A bad configuration stops it with EX_CONFIG and
// names the variable, never a value; a good one runs the first pass of each
// worker (the database is unreachable, so each pass is unavailable and no
// worker throws) and SIGTERM ends it with exit 0. Invented values only.
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { SERVER_NODE_FLAGS } from "../scripts/build/index.ts";
import { EXIT_CONFIGURATION } from "./config/index.ts";
import { WORKER_EVIDENCE_DOMAIN_VARIABLE } from "./http/index.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ENTRY = join(ROOT, "server/worker-main.ts");
const CANARY = "invented-canary-77c2";
const GOOD = {
  NODE_ENV: "test",
  WORKER_DATABASE_URL: `postgres://worker:${CANARY}@127.0.0.1:1/ductura`,
  [WORKER_EVIDENCE_DOMAIN_VARIABLE]: "00000000-0000-4000-8000-0000000000d1",
};

function run(env: Record<string, string>) {
  const child = spawn(process.execPath, [...SERVER_NODE_FLAGS, ENTRY], {
    cwd: ROOT,
    env: { PATH: process.env.PATH ?? "", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (chunk: Buffer) => (out += String(chunk)));
  child.stderr.on("data", (chunk: Buffer) => (out += String(chunk)));
  const exit = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  return { child, exit, output: () => out };
}

describe("server/worker-main.ts", () => {
  it("without a configuration exits EX_CONFIG, names each variable and leaks no value", async () => {
    const { exit, output } = run({
      NODE_ENV: "test",
      WORKER_DATABASE_URL: `postgres://worker:${CANARY}@127.0.0.1:1/ductura`,
    });
    expect(await exit).toBe(EXIT_CONFIGURATION);
    expect(output()).toContain("WORKER_EVIDENCE_DOMAIN_ID is not a uuid");
    expect(output()).not.toContain(CANARY);
  });

  it("a configuration with no database names that variable and starts nothing", async () => {
    const { exit, output } = run({ NODE_ENV: "test" });
    expect(await exit).toBe(EXIT_CONFIGURATION);
    expect(output()).toContain("WORKER_DATABASE_URL is not set");
    expect(output()).not.toContain("worker.started");
  });

  it("runs the first pass of all three workers and ends on SIGTERM with exit 0", async () => {
    const { child, exit, output } = run(GOOD);
    await waitUntil(() =>
      [
        "worker.receipt_signing.pass",
        "worker.reconstruction_checkpoints.pass",
        "worker.submission_verdict.pass",
      ].every((event) => output().includes(event)),
    );
    child.kill("SIGTERM");
    expect(await exit).toBe(0);
    expect(output()).not.toContain(CANARY);
  }, 30_000);
});

async function waitUntil(done: () => boolean): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!done()) {
    if (Date.now() > deadline) throw new Error("the workers did not run a pass");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

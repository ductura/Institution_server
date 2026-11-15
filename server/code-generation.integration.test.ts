// The server process cannot run a string as code (DAN-772). dist/server.js is
// built as `pnpm build` builds it and started with the exact command of
// `pnpm start`; test-support/code-generation-probe is loaded into the same
// process through `--import` in front of those arguments and reports what eval and the Function
// constructor do there. The server must still start, so its dependencies load
// under the flag. No Docker: the database host is .invalid and nothing
// connects at startup. Invented values only.
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildServer, SERVER_NODE_FLAGS } from "../scripts/build/index.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PROBE = pathToFileURL(join(ROOT, "test-support/code-generation-probe/probe.ts")).href;
const DATABASE_URL = "postgres://app:invented-canary-c0de@db.invalid:5432/ductura";
const START = (
  JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: { start: string } }
).scripts.start;

let dir: string | undefined;
const children: ChildProcess[] = [];

type Report = { probe: Record<string, string>; listening: boolean };

/** Starts `node <args>` with the probe preloaded; resolves once the server listens or exits. */
async function run(args: readonly string[]): Promise<Report> {
  const child = spawn(process.execPath, ["--import", PROBE, ...args], {
    cwd: dir,
    env: { PATH: process.env.PATH ?? "", PORT: "0", APP_DATABASE_URL: DATABASE_URL },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  const stdout: string[] = [];
  const stderr: string[] = [];
  child.stdout?.on("data", (chunk: Buffer) => stdout.push(String(chunk)));
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(String(chunk)));
  const exit = new Promise<void>((resolve) => child.on("exit", () => resolve()));
  const deadline = Date.now() + 10_000;
  const lines = (): string[] => stdout.join("").split("\n");
  while (Date.now() < deadline && child.exitCode === null) {
    if (lines().some((l) => l.includes("server.listening"))) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const listening = lines().some((l) => l.includes("server.listening"));
  child.kill("SIGTERM");
  await exit;
  const line = lines().find((l) => l.includes("codegen.probe"));
  if (line === undefined) throw new Error(`no probe line: ${stderr.join("")}`);
  return { probe: (JSON.parse(line) as { results: Record<string, string> }).results, listening };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "ductura-codegen-"));
  await buildServer(ROOT, join(dir, "dist/server.js"));
}, 60_000);

afterAll(() => {
  for (const child of children) child.kill("SIGKILL");
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
});

describe("the server process and code generation from strings (DAN-772)", () => {
  it("pnpm start is node, the server flags and the built file", () => {
    const [node, ...args] = START.split(" ");
    expect(node).toBe("node");
    expect(args).toEqual([...SERVER_NODE_FLAGS, "dist/server.js"]);
  });

  it("under `pnpm start` every string-to-code path throws EvalError and the server still listens", async () => {
    const { probe, listening } = await run(START.split(" ").slice(1));
    expect(probe["Function(string)"]).toBe("EvalError");
    expect(probe["(() => 0).constructor(string)"]).toBe("EvalError");
    expect(Object.keys(probe).length).toBeGreaterThanOrEqual(6);
    for (const outcome of Object.values(probe)) expect(outcome).toBe("EvalError");
    expect(listening).toBe(true);
  }, 20_000);

  it("the probe sees the difference: without the flags every path runs", async () => {
    const { probe, listening } = await run(["dist/server.js"]);
    for (const outcome of Object.values(probe)) expect(outcome).toBe("ran");
    expect(listening).toBe(true);
  }, 20_000);
});

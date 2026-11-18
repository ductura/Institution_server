import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SERVER_NODE_FLAGS } from "../../../scripts/build/index.ts";

// DAN-822-5b1: that an attempt past its time ends a real process, checked in
// child processes with the real watch thread (integration project: more than
// one part of the stack, a real process and thread).
const here = path.dirname(fileURLToPath(import.meta.url));

// The real thread in a child process, run with the server's node flags.
const work = mkdtempSync(path.join(tmpdir(), "ductura-fence-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));
const fenceModule = pathToFileURL(path.join(here, "attempt-fence.ts")).href;
// Review and QA FAIL on #300 (c.6976763795, c.6976741913): a deadline is
// measured from the real arm to the signal, not from a mark before arm to the
// parent seeing the end. The witness, preloaded with --import, runs in every
// thread of the child; only in the fence's watch (workerData is its cell) it
// writes the watch's monotonic time just before the watch's real kill.
const witness = path.join(work, "witness.mjs");
writeFileSync(
  witness,
  `import { writeFileSync } from "node:fs";
import { isMainThread, workerData } from "node:worker_threads";
if (!isMainThread && workerData instanceof SharedArrayBuffer) {
  const kill = process.kill;
  process.kill = (pid, signal) => {
    writeFileSync(process.env.FENCE_SIGNAL_FILE, String(process.hrtime.bigint()));
    return kill.call(process, pid, signal);
  };
}
`,
);
let scripts = 0;
// For the last run: every monotonic time arm read (its deadline is the one
// read plus ms), and the watch's time at its signal, if it sent one.
// process.hrtime is the process's monotonic clock, one for all its threads.
let armReads: bigint[] = [];
let signalAt: bigint | undefined;

type Ending = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

async function run(body: string, module = fenceModule): Promise<Ending> {
  scripts += 1;
  const file = path.join(work, `case-${scripts}.mjs`);
  const armFile = `${file}.arm`;
  const signalFile = `${file}.signal`;
  writeFileSync(
    file,
    `import { writeFileSync } from "node:fs";
import { startAttemptFence } from ${JSON.stringify(module)};
const fence = startAttemptFence();
// fence.arm(ms), with every time it reads on the main thread's clock written down.
const armed = (ms) => {
  const real = process.hrtime.bigint;
  const reads = [];
  process.hrtime.bigint = () => { const now = real(); reads.push(String(now)); return now; };
  try { return fence.arm(ms); } finally {
    process.hrtime.bigint = real;
    writeFileSync(${JSON.stringify(armFile)}, JSON.stringify(reads));
  }
};
const later = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// The main thread's clock only, past every deadline: the watch keeps the real one.
const late = () => { const real = process.hrtime.bigint; process.hrtime.bigint = () => real() + 5_000_000_000n; };
${body}
`,
  );
  const child = spawn(
    process.execPath,
    [...SERVER_NODE_FLAGS, "--import", pathToFileURL(witness).href, file],
    {
      env: { ...process.env, ...Object.fromEntries([["FENCE_SIGNAL_FILE", signalFile]]) },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  // A child the fence did not end is stopped with SIGTERM, never SIGKILL, so
  // it cannot pass for one the fence killed; before vitest's own 5 s timeout.
  const stop = setTimeout(() => child.kill("SIGTERM"), 4000);
  return new Promise((resolve) => {
    child.on("close", (code, signal) => {
      clearTimeout(stop);
      armReads = existsSync(armFile)
        ? (JSON.parse(readFileSync(armFile, "utf8")) as string[]).map(BigInt)
        : [];
      signalAt = existsSync(signalFile) ? BigInt(readFileSync(signalFile, "utf8")) : undefined;
      resolve({ code, signal, stdout, stderr });
    });
  });
}

/**
 * The last run's kill came from the watch, no earlier than the deadline of
 * its one armed attempt (the time arm read plus `ms`, no tolerance before it)
 * and less than 2 s after it.
 */
function expectSignalAtDeadline(ms: number): void {
  expect(armReads).toHaveLength(1);
  expect(signalAt).toBeDefined();
  const deadline = (armReads[0] ?? 0n) + BigInt(ms) * 1_000_000n;
  expect(signalAt).toBeGreaterThanOrEqual(deadline);
  expect(signalAt).toBeLessThan(deadline + 2_000_000_000n);
}

describe("startAttemptFence: a real process", () => {
  it("kills an attempt that blocks the thread past its time, and nothing is written after", async () => {
    expect(await run(`armed(300); console.log("armed"); for (;;) {}`)).toEqual({
      code: null,
      signal: "SIGKILL",
      stdout: "armed\n",
      stderr: "",
    });
    expectSignalAtDeadline(300);
  });

  it("a release after the time never returns, and the process is killed at the real deadline", async () => {
    expect(
      await run(
        `const release = armed(1000); console.log("armed"); late(); console.log("before release"); release(); console.log("after release");`,
      ),
    ).toEqual({ code: null, signal: "SIGKILL", stdout: "armed\nbefore release\n", stderr: "" });
    // Review and QA FAIL on #296 (c.6966870807, c.6966517620): the kill lands
    // at the real deadline, not at the release.
    expectSignalAtDeadline(1000);
  });

  it("close does not end the watch under a live attempt: a late release after close is killed", async () => {
    expect(
      await run(
        `const release = armed(1000); await fence.close(); console.log("closed"); late(); release(); console.log("after release");`,
      ),
    ).toEqual({ code: null, signal: "SIGKILL", stdout: "closed\n", stderr: "" });
    expectSignalAtDeadline(1000);
  });

  it("close does not end the watch under a live attempt: one that blocks after close is killed", async () => {
    expect(
      await run(`armed(300); await fence.close(); console.log("closed"); for (;;) {}`),
    ).toEqual({ code: null, signal: "SIGKILL", stdout: "closed\n", stderr: "" });
    expectSignalAtDeadline(300);
  });

  it("an attempt released in time, then close, lets the process exit 0", async () => {
    // fence.arm, not armed: no file is written between arm and a timely release.
    expect(
      await run(
        `const release = fence.arm(300); release(); await fence.close(); await later(500); console.log("done");`,
      ),
    ).toEqual({ code: 0, signal: null, stdout: "done\n", stderr: "" });
    expect(signalAt).toBeUndefined();
  });

  it("an idle fence does not keep the process alive", async () => {
    expect(await run(`console.log("done");`)).toEqual({
      code: 0,
      signal: null,
      stdout: "done\n",
      stderr: "",
    });
    expect(signalAt).toBeUndefined();
  });
});

// Review and QA FAIL on #300 (c.6976763795, c.6976741913): not watchScript
// alone, but the watch the starter itself starts when it runs as a .js module,
// as next to the bundle (DAN-822-6). The fence and its watch are each bundled
// by esbuild into a folder with no .ts file, so only the .js watch can kill.
const bundled = path.join(work, "bundle");
beforeAll(async () => {
  mkdirSync(bundled);
  for (const name of ["attempt-fence", "attempt-fence-watch"]) {
    await build({
      entryPoints: [path.join(here, `${name}.ts`)],
      outfile: path.join(bundled, `${name}.js`),
      bundle: true,
      format: "esm",
      platform: "node",
      // As buildServer (scripts/build/server.ts) builds the server bundle.
      target: "node24",
      logLevel: "warning",
    });
  }
}, 60_000);

describe("startAttemptFence from a .js module: a real process", () => {
  it("starts the .js watch next to that module, and it kills at the deadline", async () => {
    expect(readdirSync(bundled).sort()).toEqual(["attempt-fence-watch.js", "attempt-fence.js"]);
    const module = pathToFileURL(path.join(bundled, "attempt-fence.js")).href;
    expect(await run(`armed(300); console.log("armed"); for (;;) {}`, module)).toEqual({
      code: null,
      signal: "SIGKILL",
      stdout: "armed\n",
      stderr: "",
    });
    expectSignalAtDeadline(300);
  });
});

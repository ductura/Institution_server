import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { SERVER_NODE_FLAGS } from "../../../scripts/build/index.ts";

// DAN-822-5b1: that an attempt past its time ends a real process, checked in
// child processes with the real watch thread (integration project: more than
// one part of the stack, a real process and thread).
const here = path.dirname(fileURLToPath(import.meta.url));

// The real thread in a child process, run with the server's node flags.
const work = mkdtempSync(path.join(tmpdir(), "ductura-fence-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));
const fenceModule = pathToFileURL(path.join(here, "attempt-fence.ts")).href;
let scripts = 0;
// Nanoseconds on the system's monotonic clock from the child's mark() to the
// parent seeing it end, for the last run; -1 without a mark. process.hrtime is
// CLOCK_MONOTONIC, one clock for every process on the machine.
let afterMark = -1n;

type Ending = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

async function run(body: string): Promise<Ending> {
  scripts += 1;
  const file = path.join(work, `case-${scripts}.mjs`);
  const markFile = `${file}.mark`;
  writeFileSync(
    file,
    `import { writeFileSync } from "node:fs";
import { startAttemptFence } from ${JSON.stringify(fenceModule)};
// The real monotonic time, written before arm, so a deadline is no earlier than it plus ms.
const mark = () => writeFileSync(${JSON.stringify(markFile)}, String(process.hrtime.bigint()));
const fence = startAttemptFence();
const later = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// The main thread's clock only, past every deadline: the watch keeps the real one.
const late = () => { const real = process.hrtime.bigint; process.hrtime.bigint = () => real() + 5_000_000_000n; };
${body}
`,
  );
  const child = spawn(process.execPath, [...SERVER_NODE_FLAGS, file], {
    stdio: ["ignore", "pipe", "pipe"],
  });
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
      const end = process.hrtime.bigint();
      afterMark = existsSync(markFile) ? end - BigInt(readFileSync(markFile, "utf8")) : -1n;
      resolve({ code, signal, stdout, stderr });
    });
  });
}

describe("startAttemptFence: a real process", () => {
  it("kills an attempt that blocks the thread past its time, and nothing is written after", async () => {
    expect(await run(`fence.arm(300); console.log("armed"); for (;;) {}`)).toEqual({
      code: null,
      signal: "SIGKILL",
      stdout: "armed\n",
      stderr: "",
    });
  });

  it("a release after the time never returns, and the process is killed at the real deadline", async () => {
    expect(
      await run(
        `mark(); const release = fence.arm(1000); console.log("armed"); late(); console.log("before release"); release(); console.log("after release");`,
      ),
    ).toEqual({ code: null, signal: "SIGKILL", stdout: "armed\nbefore release\n", stderr: "" });
    // Review and QA FAIL on #296 (c.6966870807, c.6966517620): the kill lands
    // at the real deadline, not at the release. The deadline is at least 1000
    // ms after mark(), the kill no earlier, and the parent sees it later still:
    // no tolerance before the deadline, on one monotonic clock.
    expect(afterMark).toBeGreaterThanOrEqual(1_000_000_000n);
    expect(afterMark).toBeLessThan(3_000_000_000n);
  });

  it("close does not end the watch under a live attempt: a late release after close is killed", async () => {
    expect(
      await run(
        `const release = fence.arm(1000); await fence.close(); console.log("closed"); late(); release(); console.log("after release");`,
      ),
    ).toEqual({ code: null, signal: "SIGKILL", stdout: "closed\n", stderr: "" });
  });

  it("close does not end the watch under a live attempt: one that blocks after close is killed", async () => {
    expect(
      await run(`fence.arm(300); await fence.close(); console.log("closed"); for (;;) {}`),
    ).toEqual({ code: null, signal: "SIGKILL", stdout: "closed\n", stderr: "" });
  });

  it("an attempt released in time, then close, lets the process exit 0", async () => {
    expect(
      await run(
        `const release = fence.arm(300); release(); await fence.close(); await later(500); console.log("done");`,
      ),
    ).toEqual({ code: 0, signal: null, stdout: "done\n", stderr: "" });
  });

  it("an idle fence does not keep the process alive", async () => {
    expect(await run(`console.log("done");`)).toEqual({
      code: 0,
      signal: null,
      stdout: "done\n",
      stderr: "",
    });
  });
});

import { spawn } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { SERVER_NODE_FLAGS } from "../../../scripts/build/index.ts";

// DAN-822-5 (Ductus D-74, attack plan #1826 W-3 and W-4), ported from Ductus
// src/server/attempt-fence.test.ts with the same claims: the fence ends a real
// node process. Each case is a child, run with the server's node flags, that
// arms the fence and then behaves as one class of attempt; what is compared is
// how the child ended and what it wrote. The time an attempt is armed for is
// on the process's monotonic clock, which the watch reads in its own thread,
// so a fake clock on this side would arm the watch for a wrong time: real
// deadlines with wide margins, as in Ductus.
const work = mkdtempSync(path.join(tmpdir(), "ductura-fence-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const here = path.dirname(fileURLToPath(import.meta.url));
const fenceModule = pathToFileURL(path.join(here, "attempt-fence.ts")).href;
let scripts = 0;

type Ending = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** Milliseconds from the child writing "armed" to its end; -1 if it never did. */
  afterArmed: number;
};

async function run(body: string, fence = fenceModule): Promise<Ending> {
  scripts += 1;
  const file = path.join(work, `case-${scripts}.mjs`);
  writeFileSync(
    file,
    `import { startAttemptFence } from ${JSON.stringify(fence)};
const fence = startAttemptFence();
const later = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
${body}
`,
  );
  const child = spawn(process.execPath, [...SERVER_NODE_FLAGS, file], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let armedAt = -1;
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
    if (armedAt === -1 && stdout.includes("armed")) armedAt = Date.now();
  });
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  // A child the fence did not end is stopped with SIGTERM, never SIGKILL, so
  // it cannot pass for one the fence killed.
  // Before vitest's own 5 s timeout, so a hung child shows how it ended.
  const stop = setTimeout(() => child.kill("SIGTERM"), 4000);
  return new Promise((resolve) => {
    child.on("close", (code, signal) => {
      clearTimeout(stop);
      const afterArmed = armedAt === -1 ? -1 : Date.now() - armedAt;
      resolve({ code, signal, stdout, stderr, afterArmed });
    });
  });
}

const killed = { code: null, signal: "SIGKILL", stdout: "armed\n", stderr: "" };
const survived = (stdout: string): object => ({ code: 0, signal: null, stdout, stderr: "" });

describe("attempt fence: it refuses to arm what it cannot fence", () => {
  it.each<[string, string]>([
    ["zero", "0"],
    ["a negative time", "-5"],
    ["a fraction", "0.5"],
    ["not a number", "Number.NaN"],
    ["infinity", "Number.POSITIVE_INFINITY"],
    ["minus infinity", "Number.NEGATIVE_INFINITY"],
    ["a string", `"300"`],
    ["null", "null"],
    ["nothing", "undefined"],
    ["a bigint", "300n"],
    ["an integer past the safe range", "Number.MAX_SAFE_INTEGER + 1"],
    // In nanoseconds these would not fit the 64-bit cell and would wrap.
    ["the largest safe integer", "Number.MAX_SAFE_INTEGER"],
    ["one past the longest time", "2_147_483_648"],
    ["a huge number", "1e300"],
  ])("refuses to arm for %s", async (_label, value) => {
    const ending = await run(
      `try { fence.arm(${value}); console.log("armed"); } catch (error) { console.log(error.message); } await later(600); console.log("alive");`,
    );
    expect(ending).toMatchObject(survived("fence_refused\nalive\n"));
  });

  it("arms for the longest time, and a release ends it", async () => {
    const ending = await run(
      `const release = fence.arm(2_147_483_647); console.log("armed"); release(); await later(300); console.log("done"); await fence.close();`,
    );
    expect(ending).toMatchObject(survived("armed\ndone\n"));
  });

  it("refuses to arm once closed, so no attempt runs unfenced", async () => {
    const ending = await run(
      `await fence.close(); try { fence.arm(300); console.log("armed"); } catch (error) { console.log(error.message); }`,
    );
    expect(ending).toMatchObject(survived("fence_refused\n"));
  });
});

describe("attempt fence: without its watch, the process does not run on unfenced", () => {
  // The watch is a file now (Ductus ran a string, which could not be missing):
  // a fence whose watch is not next to it fails the process, never arms silently.
  it("ends the process with an error, and the attempt writes nothing after", async () => {
    const alone = mkdtempSync(path.join(work, "alone-"));
    copyFileSync(path.join(here, "attempt-fence.ts"), path.join(alone, "attempt-fence.ts"));
    const ending = await run(
      `fence.arm(300); console.log("armed"); await later(3000); console.log("late");`,
      pathToFileURL(path.join(alone, "attempt-fence.ts")).href,
    );
    expect(ending.signal).toBeNull();
    expect(ending.code).not.toBe(0);
    expect(ending.stdout).toBe("armed\n");
    expect(ending.stderr).toContain("attempt-fence-watch.ts");
  });
});

describe("attempt fence: an attempt still armed at its time ends the process", () => {
  it.each<[string, string]>([
    ["blocks the thread", `fence.arm(300); console.log("armed"); for (;;) {}`],
    [
      "waits on something that never settles",
      `fence.arm(300); console.log("armed"); setInterval(() => {}, 1000); await new Promise(() => {});`,
    ],
    [
      "finishes after its time",
      `fence.arm(300); console.log("armed"); await later(3000); console.log("late");`,
    ],
    [
      "was armed beside one that was released",
      `const release = fence.arm(60000); fence.arm(300); release(); console.log("armed"); await later(3000); console.log("late");`,
    ],
    [
      "was armed before a later one",
      `fence.arm(300); fence.arm(60000); console.log("armed"); await later(3000); console.log("late");`,
    ],
    [
      "is still running when the fence is closed",
      `fence.arm(300); await fence.close(); console.log("armed"); await later(3000); console.log("late");`,
    ],
    [
      "was released twice by another attempt",
      `const release = fence.arm(200); fence.arm(300); release(); release(); console.log("armed"); await later(3000); console.log("late");`,
    ],
  ])("an attempt that %s is killed, and writes nothing after it", async (_label, body) => {
    const ending = await run(body);
    expect(ending).toMatchObject(killed);
    expect(ending.afterArmed).toBeGreaterThanOrEqual(250);
    expect(ending.afterArmed).toBeLessThan(3000);
  });
});

describe("attempt fence: an attempt released in time, the process lives", () => {
  it.each<[string, string]>([
    [
      "is released before its time",
      `const release = fence.arm(300); release(); await later(700); console.log("done"); await fence.close();`,
    ],
    [
      "is the later of two, after the earlier one was released",
      `const first = fence.arm(300); const second = fence.arm(60000); first(); await later(700); second(); console.log("done"); await fence.close();`,
    ],
    [
      "is released after the fence was closed",
      `const release = fence.arm(300); await fence.close(); release(); await later(700); console.log("done");`,
    ],
    ["never armed the fence", `await later(50); console.log("done");`],
  ])("a process whose attempt %s lives on and exits 0", async (_label, body) => {
    expect(await run(body)).toMatchObject(survived("done\n"));
  });

  it("an idle fence does not keep the process alive", async () => {
    const started = Date.now();
    const ending = await run(`console.log("done");`);
    expect(ending).toMatchObject(survived("done\n"));
    expect(Date.now() - started).toBeLessThan(3000);
  });
});

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { SERVER_NODE_FLAGS } from "../../scripts/build/index.ts";
import { CANARY } from "./invented.fixture.ts";

/**
 * DAN-1567: a real process that throws where nobody catches. Its whole output
 * is one line of closed codes; the message, which holds the canary, and the
 * stack are nowhere, and the process exits 1 as it would without the capture.
 */

const INDEX = fileURLToPath(new URL("./index.ts", import.meta.url));

function run(fault: string) {
  const script = `
    import { installUncaughtCapture } from ${JSON.stringify(INDEX)};
    installUncaughtCapture(process, { exit: (code) => process.exit(code) });
    ${fault}
  `;
  const child = spawnSync(
    process.execPath,
    [...SERVER_NODE_FLAGS, "--input-type=module", "-e", script],
    {
      encoding: "utf8",
      env: { PATH: process.env.PATH },
      timeout: 20_000,
    },
  );
  return { status: child.status, output: `${child.stdout}${child.stderr}` };
}

describe("an error nobody caught, in a real process", () => {
  it("leaves one redacted line and exits 1 for a thrown error", () => {
    const { status, output } = run(
      `setTimeout(() => { throw new TypeError(${JSON.stringify(CANARY)}); }, 0);`,
    );
    expect(status).toBe(1);
    const lines = output.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      level: "error",
      event: "error.uncaught",
      fields: { origin: "uncaught_exception", errorClass: "type_error" },
    });
    expect(output).not.toContain(CANARY);
    expect(output).not.toContain("at ");
  });

  it("does the same for a rejected promise nobody awaits", () => {
    const { status, output } = run(`void Promise.reject(new Error(${JSON.stringify(CANARY)}));`);
    expect(status).toBe(1);
    expect(output.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(output)).toMatchObject({
      event: "error.uncaught",
      fields: { origin: "unhandled_rejection", errorClass: "other" },
    });
    expect(output).not.toContain(CANARY);
  });
});

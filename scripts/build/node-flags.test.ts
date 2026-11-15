// The flags of SERVER_NODE_FLAGS reach `pnpm start` (DAN-772). The behaviour
// in the real process is in server/code-generation.integration.test.ts.
import { readdirSync, readFileSync } from "node:fs";
import { sep } from "node:path";

import { describe, expect, it } from "vitest";

import { OUTFILE, SERVER_NODE_FLAGS, START_SCRIPT } from "./index.ts";

const PACKAGE = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as {
  scripts: Record<string, string>;
};

describe("server node flags", () => {
  it("forbid code generation from strings", () => {
    expect(SERVER_NODE_FLAGS).toContain("--disallow-code-generation-from-strings");
  });

  it("are in the start script, before the built file", () => {
    expect(PACKAGE.scripts.start).toBe(START_SCRIPT);
    expect(START_SCRIPT).toBe(`node ${SERVER_NODE_FLAGS.join(" ")} ${OUTFILE}`);
  });

  it("are in every script that runs the server", () => {
    const runsServer = Object.entries(PACKAGE.scripts).filter(([, command]) =>
      /\b(?:dist\/server\.js|server\/server\.ts)\b/.test(command),
    );
    expect(runsServer.map(([name]) => name)).toEqual(["start"]);
    for (const [, command] of runsServer) {
      for (const flag of SERVER_NODE_FLAGS) expect(command.split(" ")).toContain(flag);
    }
  });
});

describe("tests that start a server process", () => {
  // Every child node process a test of server/ starts gets SERVER_NODE_FLAGS
  // first, so the server is tested as `pnpm start` runs it. The scan is on
  // process.execPath itself: each occurrence must open a call whose argument
  // list starts with the whole list, whatever the line breaks.
  const SERVER_DIR = new URL("../../server/", import.meta.url);
  // Exact paths under server/ that start node otherwise, with the reason.
  const EXEMPT: Readonly<Record<string, string>> = {
    // Takes its arguments from the start script of package.json itself.
    "code-generation.integration.test.ts": "start script",
    // A GC probe of one module (--expose-gc), not a server process (DAN-777).
    "http/mutation-request.integration.test.ts": "module probe",
  };
  const files = readdirSync(SERVER_DIR, { recursive: true, encoding: "utf8" })
    .map((file) => file.split(sep).join("/"))
    .filter((file) => file.endsWith(".test.ts") && !(file in EXEMPT));
  const source = (file: string): string => readFileSync(new URL(file, SERVER_DIR), "utf8");
  const CALL =
    /\b(?:spawn|spawnSync|fork|execFile|execFileSync)\(\s*process\.execPath\s*,\s*\[\s*\.\.\.SERVER_NODE_FLAGS\s*,/g;
  const uses = (text: string): number => text.split("process.execPath").length - 1;
  const flagged = (text: string): number => [...text.matchAll(CALL)].length;

  it("the scan finds the known server spawns, line breaks or not", () => {
    expect(flagged(source("server.integration.test.ts"))).toBe(1);
    expect(flagged(source("server-shutdown.integration.test.ts"))).toBe(2);
    expect(
      flagged("spawn(\n  process.execPath,\n  [\n    ...SERVER_NODE_FLAGS,\n    e,\n  ],\n)"),
    ).toBe(1);
    for (const bad of [
      "spawn(process.execPath, [entry])",
      "spawn(process.execPath, args)",
      "spawnSync(process.execPath, [...SERVER_NODE_FLAGS.slice(1), entry])",
      "const node = process.execPath; spawn(node, [...SERVER_NODE_FLAGS, entry])",
    ]) {
      expect(flagged(bad)).toBeLessThan(uses(bad));
    }
  });

  it.each(files)("%s passes the server flags to every child node process", (file) => {
    const text = source(file);
    expect(flagged(text)).toBe(uses(text));
    expect(text).not.toMatch(/--no-disallow-code-generation-from-strings/);
  });

  it.each(Object.keys(EXEMPT))("exempt file %s exists", (file) => {
    expect(() => source(file)).not.toThrow();
  });
});

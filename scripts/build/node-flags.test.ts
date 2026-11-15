// The flags of SERVER_NODE_FLAGS reach `pnpm start` (DAN-772). The behaviour
// in the real process is in server/code-generation.integration.test.ts.
import { readdirSync, readFileSync } from "node:fs";

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
  // Every spawn of node in a test of server/ passes SERVER_NODE_FLAGS, so the
  // server is tested as `pnpm start` runs it. The one exception takes its
  // arguments from the start script itself.
  const SERVER_DIR = new URL("../../server/", import.meta.url);
  const FROM_START_SCRIPT = "code-generation.integration.test.ts";
  const files = readdirSync(SERVER_DIR, { recursive: true, encoding: "utf8" }).filter(
    (file) => file.endsWith(".test.ts") && !file.endsWith(FROM_START_SCRIPT),
  );

  const spawns = (file: string): string[] =>
    [
      ...readFileSync(new URL(file, SERVER_DIR), "utf8").matchAll(
        /\bspawn\(process\.execPath,\s*\[([^\]]*)\]/g,
      ),
    ].map((match) => match[1] ?? "");

  it("the scan finds the known server spawns", () => {
    expect(spawns("server.integration.test.ts")).toHaveLength(1);
    expect(spawns("server-shutdown.integration.test.ts")).toHaveLength(2);
  });

  it.each(files)("%s passes the server flags to every spawn of node", (file) => {
    for (const args of spawns(file)) expect(args).toMatch(/^\.\.\.SERVER_NODE_FLAGS\b/);
  });
});

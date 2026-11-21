import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

import { EXIT_CONFIGURATION } from "../../config/index.ts";

const entry = fileURLToPath(new URL("../../server.ts", import.meta.url));

it("refuses startup before listening when a faculty file is invalid", () => {
  const root = mkdtempSync(join(tmpdir(), "csrv1405-startup-"));
  try {
    const directory = join(root, "config", "faculties");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "fak-a.json"), "{}");
    const result = spawnSync(process.execPath, ["--disallow-code-generation-from-strings", entry], {
      cwd: root,
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(EXIT_CONFIGURATION);
    expect(result.stderr).toContain("FACULTY_CONFIG_INVALID_SCHEMA: fak-a");
    expect(result.stdout).not.toContain("server.listening");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

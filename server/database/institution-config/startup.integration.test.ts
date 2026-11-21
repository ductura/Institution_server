import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

const entry = fileURLToPath(new URL("../../server.ts", import.meta.url));

it.each([
  ["{}", "FACULTY_CONFIG_INVALID_SCHEMA"],
  ["{ invalid", "FACULTY_CONFIG_INVALID_JSON"],
])("refuses startup before listening for %s", (contents, code) => {
  const root = mkdtempSync(join(tmpdir(), "csrv1405-startup-"));
  try {
    const directory = join(root, "config", "faculties");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "fak-a.json"), contents);
    const result = spawnSync(process.execPath, ["--disallow-code-generation-from-strings", entry], {
      cwd: root,
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(78); // EX_CONFIG (server/config/environment.ts).
    expect(result.stderr).toContain(`${code}: fak-a`);
    expect(result.stdout).not.toContain("server.listening");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

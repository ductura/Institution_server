// The build run as a script, as `pnpm build` runs it (S-1B-a, DAN-775).
// Review on 900779b: started through a symlinked path, the main check once
// compared the link with the real path of the module and exited 0 without
// building anything, while every test that calls buildServer() stayed green.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "ductura-build-"));

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function buildThrough(script: string, outfile: string): number | null {
  const result = spawnSync(process.execPath, [script, outfile], { cwd: dir, encoding: "utf8" });
  return result.status;
}

describe("node scripts/build/server.ts", () => {
  it.each([
    ["the real path", (): string => join(ROOT, "scripts/build/server.ts")],
    [
      "a symlinked repository",
      (): string => {
        const link = join(dir, "repo-link");
        symlinkSync(ROOT, link, "dir");
        return join(link, "scripts/build/server.ts");
      },
    ],
  ])(
    "builds one file when started through %s",
    (name, script) => {
      const outfile = join(dir, `${name.replaceAll(" ", "-")}.js`);
      expect(buildThrough(script(), outfile)).toBe(0);
      expect(existsSync(outfile)).toBe(true);
    },
    60_000,
  );
});

// DAN-911-2 (S-M-2; contract Ductus#1836 c.6935252300): dist/server.js does
// not start when the institutions file fails its schema. Built as `pnpm build`
// builds it, with one esbuild plugin that swaps server/settings/institutions-file.ts
// for an invented broken file; started with the production node flags. The
// refusal names the place in the file, never its value.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildServer, SERVER_NODE_FLAGS } from "../scripts/build/index.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CANARY = "Kanarinac-0911";
let dir: string | undefined;
let outfile: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "ductura-institutions-"));
  outfile = join(dir, "server.js");
  const broken = join(dir, "institutions-file.ts");
  writeFileSync(
    broken,
    `export const INSTITUTIONS_FILE: unknown = { format: "ductus-institutions-v1", institutions: [{ slug: "${CANARY}", citationStyle: "fpzg" }] };\n`,
  );
  await buildServer(ROOT, outfile, [
    {
      name: "broken-institutions",
      setup(build) {
        build.onResolve({ filter: /\/institutions-file\.ts$/ }, () => ({ path: broken }));
      },
    },
  ]);
}, 60_000);

afterAll(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
});

describe("dist/server.js with a broken institutions file", () => {
  it("refuses to start, names the place and never the value", async () => {
    const child = spawn(process.execPath, [...SERVER_NODE_FLAGS, outfile], {
      cwd: dir,
      env: {
        PATH: process.env.PATH ?? "",
        PORT: "0",
        APP_DATABASE_URL: "postgres://app:invented@db.invalid:5432/ductura",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk: Buffer) => (stderr += String(chunk)));
    const code = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
      child.on("exit", (exitCode) => {
        clearTimeout(timer);
        resolve(exitCode);
      });
    });
    expect(code).toBe(1);
    expect(stderr).toContain(
      "startup refused: institutions file is refused: INSTITUTION_SLUG_MALFORMED",
    );
    expect(stderr + stdout).not.toContain(CANARY);
    expect(stdout).not.toContain("server.listening");
  }, 20_000);
});

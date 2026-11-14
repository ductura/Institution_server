import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import prettierOff from "eslint-config-prettier";
import { afterEach, describe, expect, it } from "vitest";

// The checks run the repository's own scripts and config files in a throwaway
// folder, so the unformatted inputs never sit in the tree that `pnpm format:check`
// sees and the repository itself stays formatted.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BIN = path.join(ROOT, "node_modules", ".bin");
const CONFIG_FILES = [".prettierrc.json", ".prettierignore"];

type PackageJson = { scripts: Record<string, string> };
const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as PackageJson;

const UNFORMATTED = "export const value={a:1,b:2}\n";
const FORMATTED = "export const value = { a: 1, b: 2 };\n";
// 94 characters: past Prettier's default printWidth (80), within the repository's (100).
// It stays on one line only when .prettierrc.json is read.
const WIDE = `export const wide = { alpha: "aaaaaaaaaa", beta: "bbbbbbbbbb", gamma: "cccccccccc", d: 1 };\n`;
// The folders that hold code; an ignore pattern that hid one of them would fail here.
const CODE_DIRS = ["server", "scripts", "test-support", "tests"];

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function workspace(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "format-"));
  temps.push(dir);
  for (const name of CONFIG_FILES) copyFileSync(path.join(ROOT, name), path.join(dir, name));
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
  }
  return dir;
}

function formatCheck(dir: string): { status: number | null; output: string } {
  const script = pkg.scripts["format:check"];
  if (script === undefined) throw new Error("package.json has no format:check script");
  // Environment variable names are not ours to rename, so they are set by key.
  const env: NodeJS.ProcessEnv = { ...process.env };
  env["PATH"] = `${BIN}${path.delimiter}${process.env["PATH"] ?? ""}`;
  const run = spawnSync("sh", ["-c", script], { cwd: dir, env, encoding: "utf8" });
  return { status: run.status, output: `${run.stdout}${run.stderr}` };
}

describe("pnpm format:check", () => {
  it("fails on an unformatted file in every code folder and names each file", () => {
    const files = Object.fromEntries(CODE_DIRS.map((dir) => [`${dir}/sub/bad.ts`, UNFORMATTED]));
    const { status, output } = formatCheck(workspace(files));
    expect(status).not.toBe(0);
    for (const file of Object.keys(files)) expect(output).toContain(file);
  });

  it("passes on formatted files", () => {
    const { status, output } = formatCheck(workspace({ "server/good.ts": FORMATTED }));
    expect(output).not.toContain("good.ts");
    expect(status).toBe(0);
  });

  it("reads the repository config, not Prettier's defaults", () => {
    expect(WIDE.trimEnd().length).toBeGreaterThan(80);
    expect(WIDE.trimEnd().length).toBeLessThanOrEqual(100);
    expect(formatCheck(workspace({ "server/wide.ts": WIDE })).status).toBe(0);
  });

  it("runs in CI", () => {
    const ci = readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");
    expect(ci).toMatch(/^\s+run: pnpm format:check$/m);
  });
});

describe("lefthook pre-commit", () => {
  function git(dir: string, ...args: string[]): string {
    return execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  }

  it("formats staged files, re-stages them and leaves unstaged files alone", () => {
    const dir = workspace({ "server/staged.ts": UNFORMATTED, "server/unstaged.ts": UNFORMATTED });
    copyFileSync(path.join(ROOT, "lefthook.yml"), path.join(dir, "lefthook.yml"));
    writeFileSync(
      path.join(dir, "package.json"),
      '{ "name": "format-hook-check", "private": true }\n',
    );
    symlinkSync(path.join(ROOT, "node_modules"), path.join(dir, "node_modules"), "dir");
    git(dir, "init", "-q");
    git(dir, "add", "server/staged.ts");

    execFileSync(path.join(BIN, "lefthook"), ["run", "pre-commit"], {
      cwd: dir,
      encoding: "utf8",
      env: Object.fromEntries([...Object.entries(process.env), ["LEFTHOOK_QUIET", "meta,summary"]]),
    });

    expect(git(dir, "show", ":server/staged.ts")).toBe(FORMATTED);
    expect(readFileSync(path.join(dir, "server/staged.ts"), "utf8")).toBe(FORMATTED);
    expect(readFileSync(path.join(dir, "server/unstaged.ts"), "utf8")).toBe(UNFORMATTED);
  });
});

describe("Prettier and ESLint", () => {
  // eslint-config-prettier lists every rule that can conflict with Prettier.
  // None of them may be on in the resolved config, whatever block comes later.
  const eslint = new ESLint({
    cwd: ROOT,
    overrideConfigFile: path.join(ROOT, "eslint.config.ts"),
    flags: ["unstable_native_nodejs_ts_config"],
  });
  const conflicting = Object.keys(prettierOff.rules ?? {});

  it.each(["server/a.ts", "scripts/a.ts", "tests/a.test.ts", "a.js"])(
    "no conflicting rule is on for %s",
    async (file) => {
      expect(conflicting.length).toBeGreaterThan(0);
      const config = (await eslint.calculateConfigForFile(file)) as {
        rules?: Record<string, unknown>;
      };
      const on = conflicting.filter((rule) => {
        const entry = config.rules?.[rule];
        const severity = Array.isArray(entry) ? entry[0] : entry;
        return severity !== undefined && severity !== 0 && severity !== "off";
      });
      expect(on).toEqual([]);
    },
  );
});

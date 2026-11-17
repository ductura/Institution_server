import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { contractsGeneratorChanged } from "./auto.ts";

// DAN-974-4 (Codex #282): a generator commit that rewrote only the fake server
// does not make the next contracts route major. A real git repository; every
// file is invented.

describe("contractsGeneratorChanged", () => {
  const dir = mkdtempSync(join(tmpdir(), "release-generator-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args],
      {
        cwd: dir,
        encoding: "utf8",
      },
    ).trim();
  const commit = (files: Record<string, string>) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
      git("add", path);
    }
    git("commit", "-q", "-m", Object.keys(files).join(" "));
    return git("rev-parse", "HEAD");
  };
  const GEN = "scripts/generate-contracts.ts";
  const FAKE = "server/contracts/generated/fake-server/index.ts";
  const CLIENT = "server/contracts/generated/client.ts";
  git("init", "-q", "-b", "main");
  const tag = commit({ [GEN]: "1", [FAKE]: "1", [CLIENT]: "1", "openapi/v1.json": "1" });

  // Negative cases first: what still counts as a generator change.
  it("is true for a generator commit that also rewrote a contracts file", () => {
    const head = commit({ [GEN]: "2", [CLIENT]: "2" });
    expect(contractsGeneratorChanged(tag, head, dir)).toBe(true);
    git("reset", "-q", "--hard", tag);
  });

  it("is true for a generator commit that also changed openapi/v1.json", () => {
    const head = commit({ [GEN]: "2", "openapi/v1.json": "2" });
    expect(contractsGeneratorChanged(tag, head, dir)).toBe(true);
    git("reset", "-q", "--hard", tag);
  });

  it("is true for a merge commit and throws for an unknown commit", () => {
    git("checkout", "-q", "-b", "side");
    commit({ [GEN]: "3", [FAKE]: "3" });
    git("checkout", "-q", "main");
    commit({ "other.txt": "x" });
    git("merge", "-q", "--no-ff", "-m", "merge", "side");
    const head = git("rev-parse", "HEAD");
    git("checkout", "-q", "main");
    expect(contractsGeneratorChanged(tag, head, dir)).toBe(true);
    expect(() => contractsGeneratorChanged("b".repeat(40), head, dir)).toThrow(/rev-list failed/);
    git("reset", "-q", "--hard", tag);
  });

  it("is false when the generator commit rewrote only the fake server", () => {
    const head = commit({ [GEN]: "4", [FAKE]: "4" });
    const route = commit({ [CLIENT]: "5", "openapi/v1.json": "5" });
    expect(contractsGeneratorChanged(tag, head, dir)).toBe(false);
    expect(contractsGeneratorChanged(tag, route, dir)).toBe(false);
  });
});

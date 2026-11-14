import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { baseDocument, gitShow, type Git } from "../../scripts/index.ts";

const SCRIPT = fileURLToPath(new URL("../../scripts/check-breaking.ts", import.meta.url));
const TSX = fileURLToPath(new URL("../../node_modules/.bin/tsx", import.meta.url));
const DEFAULT_EXEC_BUFFER = 1024 * 1024;

describe("base document for the CI check", () => {
  const files = (present: Record<string, string>) => (revision: string, file: string) =>
    present[`${revision}:${file}`] ?? null;

  it("reads openapi/v1.json, else the generated file of the revision before it, else nothing", () => {
    expect(
      baseDocument(
        "b",
        files({
          "b:openapi/v1.json": '{"a":1}',
          "b:server/contracts/generated/openapi.json": '{"a":2}',
        }),
      ),
    ).toEqual({ a: 1 });
    expect(
      baseDocument("b", files({ "b:server/contracts/generated/openapi.json": '{"a":2}' })),
    ).toEqual({ a: 2 });
    expect(baseDocument("b", files({}))).toBeNull();
  });

  it("a read error is not taken for a missing document", () => {
    const show = (revision: string, file: string): string | null => {
      expect(revision).toBe("b");
      if (file === "openapi/v1.json") throw new Error("read failed");
      return '{"a":2}';
    };
    expect(() => baseDocument("b", show)).toThrow("read failed");
  });

  it("a document that is there but is not a JSON object is not taken for a missing one", () => {
    for (const text of ["null", "[]", "1", '"x"', "true"]) {
      expect(() => baseDocument("b", files({ "b:openapi/v1.json": text }))).toThrow(
        "b:openapi/v1.json is not a JSON object",
      );
    }
  });
});

describe("gitShow", () => {
  // A fake git: ls-tree answers from `tree`, cat-file from `blob`.
  const fakeGit =
    (tree: string, blob: () => string): Git =>
    (args) =>
      args[0] === "ls-tree" ? tree : blob();

  it("only a path the revision does not have is null", () => {
    expect(
      gitShow(
        "b",
        "openapi/v1.json",
        fakeGit("", () => {
          throw new Error("cat-file must not run");
        }),
      ),
    ).toBeNull();
  });

  it("an output over the buffer throws instead of reading as no document", () => {
    const enobufs = Object.assign(new Error("spawnSync git ENOBUFS"), { code: "ENOBUFS" });
    const run = fakeGit("openapi/v1.json\n", () => {
      throw enobufs;
    });
    expect(() => gitShow("b", "openapi/v1.json", run)).toThrow(enobufs);
    expect(() => baseDocument("b", (r, f) => gitShow(r, f, run))).toThrow(enobufs);
  });

  it("a failing lookup (unknown revision) throws", () => {
    const run: Git = () => {
      throw new Error("fatal: Not a valid object name b");
    };
    expect(() => gitShow("b", "openapi/v1.json", run)).toThrow("Not a valid object name");
  });
});

describe("gitShow and the CLI against a real repository", () => {
  let dir: string;
  const git = (...args: string[]) => {
    const result = spawnSync(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@primjer.invalid",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      { cwd: dir, encoding: "utf8" },
    );
    if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout.trim();
  };
  const commit = (message: string) => {
    git("add", ".");
    git("commit", "-q", "--allow-empty", "-m", message);
    return git("rev-parse", "HEAD");
  };
  const check = (revision: string) =>
    spawnSync(TSX, [SCRIPT, revision], { cwd: dir, encoding: "utf8" });
  let empty: string;
  let large: string;
  let unreadable: string;
  let jsonNull: string;
  const bigDocument = JSON.stringify({
    openapi: "3.1.0",
    pad: "x".repeat(2 * DEFAULT_EXEC_BUFFER),
  });

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "check-breaking-"));
    git("init", "-q");
    empty = commit("no document");
    mkdirSync(join(dir, "openapi"));
    writeFileSync(join(dir, "openapi", "v1.json"), bigDocument);
    large = commit("document over the default exec buffer");
    rmSync(join(dir, "openapi", "v1.json"));
    mkdirSync(join(dir, "openapi", "v1.json"));
    writeFileSync(join(dir, "openapi", "v1.json", "part.json"), "{}");
    unreadable = commit("a directory where the document should be");
    rmSync(join(dir, "openapi", "v1.json"), { recursive: true });
    writeFileSync(join(dir, "openapi", "v1.json"), "null\n");
    jsonNull = commit("a document whose content is null");
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const inRepo: Git = (args) => {
    const result = spawnSync("git", args, { cwd: dir, encoding: "utf8", maxBuffer: 1 << 28 });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout;
  };

  it("a missing file is null, an existing one is read in full past the default buffer", () => {
    expect(gitShow(empty, "openapi/v1.json", inRepo)).toBeNull();
    expect(gitShow(large, "openapi/v1.json", inRepo)).toBe(bigDocument);
  });

  it("a path that is there but cannot be read as a file throws", () => {
    expect(() => gitShow(unreadable, "openapi/v1.json", inRepo)).toThrow();
  });

  it("the CLI passes with nothing to compare only when the base has no document", () => {
    const result = check(empty);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("has no published OpenAPI document");
  });

  it("the CLI reads a base document larger than the default exec buffer", () => {
    // The document is not an OpenAPI v1 of these contracts, so the comparison
    // runs and fails; before the fix it read as "no document" and passed.
    const result = check(large);
    expect(result.stdout).not.toContain("has no published OpenAPI document");
    expect(result.status).not.toBe(0);
  });

  it("the CLI fails with a non-zero exit when the base document cannot be read", () => {
    const result = check(unreadable);
    expect(result.stdout).not.toContain("has no published OpenAPI document");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("openapi/v1.json");
  });

  it("the CLI fails with a non-zero exit when the base document is JSON null", () => {
    const result = check(jsonNull);
    expect(result.stdout).not.toContain("has no published OpenAPI document");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("is not a JSON object");
  });
});

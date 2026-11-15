import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { checkTag, CONTRACTS, isAncestorOfMain, type TagInput } from "./index.ts";

// U10-b (DAN-742): the tag that publish.yml acts on. Every value is invented.
const SHA = "a".repeat(40);
const input = (refName: string, change: Partial<TagInput> = {}): TagInput => ({
  ref: `refs/tags/${refName}`,
  refName,
  sha: SHA,
  version: (spec) => (spec === CONTRACTS ? "1.2.3" : "0.1.0"),
  apiVersion: "1.4.0",
  onMain: () => true,
  ...change,
});

describe("checkTag", () => {
  it("names the package of a well-formed tag on main", () => {
    expect(checkTag(input("contracts-v1.2.3"))).toBe("contracts");
    expect(checkTag(input("test-fakes-v0.1.0"))).toBe("test-fakes");
  });

  // The trigger glob lets these through; git allows `$`, `(`, `;` and backticks.
  it.each([
    "contracts-1.2.3",
    "contracts-v1.2",
    "contracts-v1.2.3-rc.1",
    "contracts-v01.2.3",
    "contracts-v1.2.3.4",
    "other-v1.2.3",
    "Contracts-v1.2.3",
    "contracts-v1.2.3;id",
    "contracts-v1.$(id).3",
    "contracts-v1.`id`.3",
    "contracts-v1.2.3\n",
    "",
  ])("refuses the tag name %j", (name) => {
    expect(() => checkTag(input(name))).toThrow(/^tag: name is not/);
  });

  it("refuses a missing tag name", () => {
    expect(() => checkTag(input("contracts-v1.2.3", { refName: undefined }))).toThrow(
      /^tag: name is not/,
    );
  });

  it.each([
    ["a branch", "refs/heads/contracts-v1.2.3"],
    ["another tag", "refs/tags/contracts-v1.2.4"],
    ["no ref", undefined],
  ])("refuses GITHUB_REF of %s", (_, ref) => {
    expect(() => checkTag(input("contracts-v1.2.3", { ref }))).toThrow(/GITHUB_REF/);
  });

  it("refuses a version that is not the package.json of the package", () => {
    expect(() => checkTag(input("contracts-v1.2.4"))).toThrow(/version 1\.2\.4/);
    expect(() => checkTag(input("test-fakes-v0.2.0"))).toThrow(/version 0\.2\.0/);
  });

  it("refuses contracts whose major is not the major of API_VERSION", () => {
    expect(() => checkTag(input("contracts-v1.2.3", { apiVersion: "2.0.0" }))).toThrow(/major/);
    // test-fakes has its own 0.x versions.
    expect(checkTag(input("test-fakes-v0.1.0", { apiVersion: "2.0.0" }))).toBe("test-fakes");
  });

  it.each([undefined, "", "a".repeat(39), "A".repeat(40), `${"a".repeat(40)} `])(
    "refuses GITHUB_SHA %j",
    (sha) => {
      expect(() => checkTag(input("contracts-v1.2.3", { sha }))).toThrow(/GITHUB_SHA/);
    },
  );

  it("refuses a commit that is not on main, and fails when git cannot tell", () => {
    expect(() => checkTag(input("contracts-v1.2.3", { onMain: () => false }))).toThrow(
      "tag: commit is not on main",
    );
    const broken = () => {
      throw new Error("tag: git merge-base failed (128)");
    };
    expect(() => checkTag(input("contracts-v1.2.3", { onMain: broken }))).toThrow(/128/);
  });
});

describe("isAncestorOfMain", () => {
  const dir = mkdtempSync(join(tmpdir(), "release-tag-"));
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
  const commit = (name: string) => {
    writeFileSync(join(dir, name), name);
    git("add", name);
    git("commit", "-q", "-m", name);
    return git("rev-parse", "HEAD");
  };
  git("init", "-q", "-b", "main");
  const onMain = commit("one");
  git("update-ref", "refs/remotes/origin/main", onMain);
  git("checkout", "-q", "-b", "side");
  const offMain = commit("two");

  it("is true on origin/main, false off it, and throws for an unknown commit", () => {
    expect(isAncestorOfMain(onMain, dir)).toBe(true);
    expect(isAncestorOfMain(offMain, dir)).toBe(false);
    expect(() => isAncestorOfMain("b".repeat(40), dir)).toThrow(/merge-base failed/);
  });

  // A tag named origin/main resolves before refs/remotes/origin/main.
  it("is not fooled by a tag named origin/main", () => {
    git("tag", "origin/main", offMain);
    expect(isAncestorOfMain(offMain, dir)).toBe(false);
  });
});

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  checkTag,
  CONTRACTS,
  isAncestorOfMain,
  PACKAGES,
  type PackageSpec,
  type TagInput,
} from "./index.ts";
import { releaseVersion, ROOT } from "./stage.ts";

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

  // DAN-804 (b): package.json is the floor of the major; the tag carries the version.
  it("refuses a version below package.json or off its major", () => {
    expect(() => checkTag(input("contracts-v1.2.2"))).toThrow(/version 1\.2\.2/);
    expect(() => checkTag(input("contracts-v1.1.9"))).toThrow(/version 1\.1\.9/);
    expect(() => checkTag(input("contracts-v0.9.9"))).toThrow(/version 0\.9\.9/);
    expect(() => checkTag(input("contracts-v2.0.0", { apiVersion: "2.0.0" }))).toThrow(
      /version 2\.0\.0/,
    );
    expect(() => checkTag(input("test-fakes-v1.0.0"))).toThrow(/version 1\.0\.0/);
    expect(() => checkTag(input("test-fakes-v0.0.9"))).toThrow(/version 0\.0\.9/);
    const unreadable = { version: () => "1.2" };
    expect(() => checkTag(input("contracts-v1.2.3", unreadable))).toThrow(/version 1\.2\.3/);
  });

  it("accepts a minor or patch above package.json on its major", () => {
    for (const name of ["contracts-v1.2.4", "contracts-v1.3.0", "contracts-v1.10.0"])
      expect(checkTag(input(name))).toBe("contracts");
    for (const name of ["test-fakes-v0.1.1", "test-fakes-v0.2.0"])
      expect(checkTag(input(name))).toBe("test-fakes");
  });

  // DAN-804: publish.yml takes workflow_dispatch; on a branch it stops here.
  it("refuses a dispatch on a branch", () => {
    const main = { ref: "refs/heads/main", refName: "main" };
    expect(() => checkTag(input("main", main))).toThrow(/^tag: name is not/);
    const named = { ref: "refs/heads/contracts-v1.2.3" };
    expect(() => checkTag(input("contracts-v1.2.3", named))).toThrow(/GITHUB_REF/);
  });

  // DAN-869: the package major follows breaking changes of the TypeScript types,
  // not of the wire, so it may be above the API major but never below it.
  it("refuses contracts whose major is below the major of API_VERSION", () => {
    expect(() => checkTag(input("contracts-v1.2.3", { apiVersion: "2.0.0" }))).toThrow(
      "tag: major 1 is below the major of API_VERSION 2.0.0",
    );
    const zero = { version: () => "0.1.0" };
    expect(() => checkTag(input("contracts-v0.1.0", zero))).toThrow(/major 0 is below/);
    // test-fakes has its own versions.
    expect(checkTag(input("test-fakes-v0.1.0", { apiVersion: "2.0.0" }))).toBe("test-fakes");
  });

  it("accepts contracts on or above the major of API_VERSION", () => {
    const two = { version: (spec: PackageSpec) => (spec === CONTRACTS ? "2.0.0" : "1.0.0") };
    expect(checkTag(input("contracts-v2.0.0", two))).toBe("contracts");
    expect(checkTag(input("contracts-v2.3.1", two))).toBe("contracts");
    expect(checkTag(input("contracts-v1.2.3", { apiVersion: "1.0.0" }))).toBe("contracts");
    expect(checkTag(input("test-fakes-v1.0.0", two))).toBe("test-fakes");
  });

  it.each([
    "",
    "undefined",
    "1",
    "1.2",
    "01.0.0",
    "v1.0.0",
    "1.0.0-rc.1",
    "1.0.0+b",
    "-1.0.0",
    " 1.0.0",
    "1.0.0\n",
  ])("refuses contracts when API_VERSION %j is not X.Y.Z", (apiVersion) => {
    expect(() => checkTag(input("contracts-v1.2.3", { apiVersion }))).toThrow(
      /^tag: API_VERSION .* is not X\.Y\.Z$/su,
    );
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

// DAN-869: the versions in the repo, read as release:tag reads them.
describe("the repo's own versions", () => {
  const read = (...path: string[]) =>
    JSON.parse(readFileSync(join(ROOT, ...path), "utf8")) as {
      version?: unknown;
      info?: { version?: unknown };
    };
  const real = {
    version: (spec: PackageSpec) => String(read(spec.dir, "package.json").version),
    apiVersion: String(read("openapi", "v1.json").info?.version),
  };

  it.each(PACKAGES.map((spec) => [spec.name, spec] as const))(
    "%s tags its own package.json version",
    (_, spec) => {
      const name = `${spec === CONTRACTS ? "contracts" : "test-fakes"}-v${real.version(spec)}`;
      expect(checkTag(input(name, real))).toBe(spec === CONTRACTS ? "contracts" : "test-fakes");
    },
  );

  // DAN-974 (after DAN-964): the approved test-fakes major. Older lines stop here.
  // DAN-974-3: test-fakes-v3.0.0 sits on an older commit and tags cannot move
  // (U10), so 3.0.0 is skipped and 3.0.1 is the floor.
  // DAN-974-4: 3.1.0 was the floor (two new routes, additive; API_VERSION unchanged).
  // #343: FakeOidcOptions gained `accounts?`, a major by the #92 rule; 4.0.0 is the floor.
  it("takes test-fakes-v4.0.0 and refuses the 3.x and older lines", () => {
    for (const name of [
      "test-fakes-v3.0.0",
      "test-fakes-v3.0.1",
      "test-fakes-v3.1.0",
      "test-fakes-v3.1.1",
      "test-fakes-v3.99.0",
      "test-fakes-v2.0.0",
      "test-fakes-v1.99.0",
      "test-fakes-v0.2.1",
    ])
      expect(() => checkTag(input(name, real))).toThrow(/version/);
    expect(() => checkTag(input("test-fakes-v5.0.0", real))).toThrow(/version 5\.0\.0/);
    expect(checkTag(input("test-fakes-v4.0.0", real))).toBe("test-fakes");
    expect(checkTag(input("test-fakes-v4.0.1", real))).toBe("test-fakes");
    expect(checkTag(input("test-fakes-v4.1.0", real))).toBe("test-fakes");
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

// DAN-804: the published version is the tag's (publish.yml RELEASE_VERSION).
describe("releaseVersion", () => {
  it("takes the tag's version on the major of package.json, at or above it", () => {
    expect(releaseVersion("1.1.0")).toBe("1.1.0");
    expect(releaseVersion("1.1.0", "1.1.0")).toBe("1.1.0");
    expect(releaseVersion("1.1.0", "1.4.2")).toBe("1.4.2");
    for (const version of ["1.0.9", "2.0.0", "1.2", "1.2.3-rc.1", "01.2.0", ""])
      expect(() => releaseVersion("1.1.0", version)).toThrow(/release version/);
  });
});

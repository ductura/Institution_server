import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { API_VERSION } from "../../server/contracts/index.ts";
import {
  compareFiles,
  CONTRACTS,
  manifestErrors,
  PACKAGES,
  parsePackOutput,
  publishManifest,
  scanSecrets,
  TEST_FAKES,
} from "./index.ts";
import { ROOT } from "./stage.ts";

const source = (dir: string) =>
  JSON.parse(readFileSync(join(ROOT, dir, "package.json"), "utf8")) as {
    private?: boolean;
    version: string;
    description: string;
    dependencies?: Record<string, string>;
  };

const manifest = (spec = TEST_FAKES) =>
  JSON.parse(JSON.stringify(publishManifest(spec, source(spec.dir)))) as Record<string, unknown>;

const PACK = {
  name: "@ductura/contracts",
  version: "1.0.0",
  files: [{ path: "a.js", size: 1, mode: 420 }],
};

describe("npm pack output", () => {
  it("accepts one package with its files", () => {
    expect(parsePackOutput(JSON.stringify([PACK]))[0].files[0]?.path).toBe("a.js");
  });

  it.each([
    ["not JSON", "npm WARN"],
    ["an object instead of an array", JSON.stringify(PACK)],
    ["two packages", JSON.stringify([PACK, PACK])],
    ["no package", "[]"],
    ["a file without path", JSON.stringify([{ ...PACK, files: [{ size: 1, mode: 420 }] }])],
    ["an empty path", JSON.stringify([{ ...PACK, files: [{ path: "", size: 1, mode: 420 }] }])],
    ["files not an array", JSON.stringify([{ ...PACK, files: "a.js" }])],
  ])("refuses %s", (_, text) => {
    expect(() => parsePackOutput(text)).toThrow(/npm pack/u);
  });
});

describe("file list", () => {
  it("names every extra and every missing file", () => {
    expect(compareFiles(["a.js", ".env"], ["a.js", "b.js"])).toEqual([
      "unexpected file .env",
      "missing file b.js",
    ]);
  });

  it.each(PACKAGES)("$name lists no test, source, env, http or db file", (spec) => {
    for (const path of spec.files)
      expect(path).not.toMatch(/\.test\.|(?<!\.d)\.ts$|\.env|^server\/(?!contracts\/)|^db\//u);
  });
});

describe("secret scan", () => {
  it.each([
    ["-----BEGIN PRIVATE KEY-----\nAAAA", "private key"],
    ["-----BEGIN EC PRIVATE KEY-----", "private key"],
    [`token=ghp_${"a".repeat(36)}`, "GitHub token"],
    [`github_pat_${"B".repeat(30)}`, "GitHub token"],
    [`npm_${"c".repeat(36)}`, "npm token"],
    ["AKIAABCDEFGHIJKLMNOP", "AWS access key"],
    ["postgres://user:pass@db.invalid/x", "database URL with password"],
  ])("finds %j", (text, kind) => {
    expect(scanSecrets({ "x.js": text })).toEqual([{ path: "x.js", kind }]);
  });

  it("passes ordinary code", () => {
    expect(scanSecrets({ "x.js": 'const url = "postgres://db.invalid/x"; // ghp_short' })).toEqual(
      [],
    );
  });
});

describe("publish manifest", () => {
  it.each(PACKAGES)("$name as staged is fit to publish", (spec) => {
    expect(manifestErrors(spec, manifest(spec))).toEqual([]);
  });

  it.each(PACKAGES)("$name stays private in the repository", (spec) => {
    expect(source(spec.dir).private).toBe(true);
  });

  it("test-fakes publishes neither /pglite nor its dependency", () => {
    const own = manifest();
    expect(Object.keys(own.exports as object)).not.toContain("./pglite");
    expect(own.dependencies).toEqual({
      "oidc-provider": source(TEST_FAKES.dir).dependencies?.["oidc-provider"],
    });
    expect(TEST_FAKES.files.some((path) => path.includes("pglite"))).toBe(false);
  });

  it("the contracts major is the API major", () => {
    expect(source(CONTRACTS.dir).version.split(".")[0]).toBe(API_VERSION.split(".")[0]);
  });

  it.each([
    ["private", { private: true }, /private is set/u],
    ["bin", { bin: { x: "./x.js" } }, /bin or scripts/u],
    [
      "another registry",
      { publishConfig: { registry: "https://registry.npmjs.org" } },
      /registry/u,
    ],
    ["another name", { name: "test-fakes" }, /name/u],
    [
      "another repository",
      { repository: { url: "git+https://github.com/x/y.git" } },
      /repository/u,
    ],
    [
      "/pglite",
      { exports: { "./pglite": { default: "./packages/test-fakes/pglite/index.js" } } },
      /pglite/u,
    ],
    [
      "a missing export target",
      { exports: { ".": { default: "./nope.js" } } },
      /not in the package/u,
    ],
    ["an extra dependency", { dependencies: { "@electric-sql/pglite": "0.3.14" } }, /unexpected/u],
    ["a range", { dependencies: { "oidc-provider": "^9.12.2" } }, /exact version/u],
  ])("test-fakes refuses %s", (_, change, error) => {
    expect(manifestErrors(TEST_FAKES, { ...manifest(), ...change }).join("\n")).toMatch(error);
  });

  it.each(["dependencies", "peerDependencies", "optionalDependencies"])(
    "contracts refuse test-fakes in %s",
    (field) => {
      const own = { ...manifest(CONTRACTS), [field]: { "@ductura/test-fakes": "0.1.0" } };
      expect(manifestErrors(CONTRACTS, own).join("\n")).toMatch(
        /contracts depend on @ductura\/test-fakes/u,
      );
    },
  );
});

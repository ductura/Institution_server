import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { API_VERSION } from "../../server/contracts/index.ts";
import {
  compareFiles,
  importErrors,
  CONTRACTS,
  manifestErrors,
  PACKAGES,
  REGISTRY,
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
    [
      "a path outside",
      JSON.stringify([{ ...PACK, files: [{ path: "../x", size: 1, mode: 420 }] }]),
    ],
    [
      "an absolute path",
      JSON.stringify([{ ...PACK, files: [{ path: "/x", size: 1, mode: 420 }] }]),
    ],
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
    ["-----BEGIN PGP PRIVATE KEY BLOCK-----", "private key"],
    ["POSTGRES://u:pw@db.invalid", "database URL with password"],
    ["postgres://:pw@db.invalid", "database URL with password"],
    ["postgresql://db.invalid/x?password=pw", "database URL with password"],
    [`npm_${"c".repeat(37)}`, "npm token"],
    ["ASIAABCDEFGHIJKLMNOP", "AWS access key"],
    [`{"kty":"EC","d":"${"k".repeat(43)}"}`, "private JWK"],
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
    ["private", { private: true }, /manifest \/private/u],
    ["bin", { bin: { x: "./x.js" } }, /manifest \/bin/u],
    ["directories.bin", { directories: { bin: "./b" } }, /manifest \/directories/u],
    ["main", { main: "./x.js" }, /manifest \/main/u],
    ["imports", { imports: { "#x": "./x.js" } }, /manifest \/imports/u],
    ["a peer", { peerDependencies: { "@electric-sql/pglite": "*" } }, /manifest \/peer/u],
    ["an optional", { optionalDependencies: { x: "1.0.0" } }, /manifest \/optional/u],
    ["bundled", { bundleDependencies: ["oidc-provider"] }, /manifest \/bundle/u],
    [
      "another registry",
      { publishConfig: { registry: "https://registry.npmjs.org" } },
      /registry/u,
    ],
    [
      "publishConfig with exports",
      { publishConfig: { registry: REGISTRY, exports: { "./pglite": {} } } },
      /publishConfig\/exports/u,
    ],
    ["another name", { name: "@ductura/other" }, /manifest names/u],
    ["a name outside @ductura", { name: "test-fakes" }, /manifest \/name/u],
    [
      "another repository",
      { repository: { type: "git", url: "x", directory: "y" } },
      /repository/u,
    ],
    [
      "/pglite",
      { exports: { "./pglite": { types: "./a.d.ts", default: "./a.js" } } },
      /exports \/pglite/u,
    ],
    [
      "nested conditions",
      { exports: { ".": { node: { default: "./a.js" } } } },
      /manifest \/exports/u,
    ],
    ["string exports", { exports: "./a.js" }, /manifest \/exports/u],
    [
      "a missing export target",
      { exports: { ".": { types: "./nope.d.ts", default: "./nope.js" } } },
      /not in the package/u,
    ],
    ["an extra dependency", { dependencies: { "@electric-sql/pglite": "0.3.14" } }, /unexpected/u],
    ["a range", { dependencies: { "oidc-provider": "^9.12.2" } }, /manifest \/dependencies/u],
  ])("test-fakes refuses %s", (_, change, error) => {
    expect(manifestErrors(TEST_FAKES, { ...manifest(), ...change }).join("\n")).toMatch(error);
  });

  it.each([null, "x", []])("refuses the manifest %j", (value) => {
    expect(manifestErrors(TEST_FAKES, value)).not.toEqual([]);
  });

  it("contracts refuse test-fakes as a dependency", () => {
    const own = { ...manifest(CONTRACTS), dependencies: { "@ductura/test-fakes": "0.1.0" } };
    expect(manifestErrors(CONTRACTS, own).join("\n")).toMatch(
      /contracts depend on @ductura\/test-fakes/u,
    );
  });
});

describe("imports of the packed code", () => {
  const FILES = ["a/index.js", "a/b.js"];
  it("accepts node:, listed files and declared packages", () => {
    const code = 'import "node:fs";\nexport * from "./b.js";\nimport { x } from "dep/sub";';
    expect(importErrors({ "a/index.js": code }, FILES, ["dep"])).toEqual([]);
  });

  it.each([
    ['export * from "./extra.js";', "a/index.js imports ./extra.js, not in the package"],
    ['import "../../outside.js";', "a/index.js imports ../../outside.js, not in the package"],
    [
      'import { Type } from "@sinclair/typebox/value";',
      "a/index.js imports undeclared @sinclair/typebox",
    ],
    ['const m = await import("oidc-provider");', "a/index.js imports undeclared oidc-provider"],
  ])("refuses %s", (code, error) => {
    expect(importErrors({ "a/index.js": code }, FILES, ["dep"])).toEqual([error]);
  });
});

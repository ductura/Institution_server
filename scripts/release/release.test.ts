import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { API_VERSION } from "../../server/contracts/index.ts";
import {
  compareFiles,
  exportTargets,
  importErrors,
  npmCliPath,
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

  it("contracts export the OpenAPI document", () => {
    expect((manifest(CONTRACTS).exports as Record<string, unknown>)["./openapi/v1.json"]).toBe(
      "./openapi/v1.json",
    );
  });

  // DAN-869: the package major may be above the API major, never below it.
  it("the contracts major is not below the API major", () => {
    const major = (version: string) => Number(version.split(".")[0]);
    expect(major(source(CONTRACTS.dir).version)).toBeGreaterThanOrEqual(major(API_VERSION));
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
      "a code export without declarations",
      { exports: { "./x": "./packages/test-fakes/release.js" } },
      /manifest \/exports/u,
    ],
    [
      "a data export not in the package",
      { exports: { "./x.json": "./x.json" } },
      /not in the package/u,
    ],
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

  it("reads a property named from or import as no import", () => {
    const code =
      "const ok = typeof value['from'] === 'number' && value[\"import\"] !== \"x\";\n" +
      'import { y } from "@sinclair/typebox";';
    expect(importErrors({ "a/index.js": code }, FILES, ["dep"])).toEqual([
      "a/index.js imports undeclared @sinclair/typebox",
    ]);
  });

  it.each([['x}from"y";'], ['import"y";'], ['export*as"b"from"y";'], ['import{"a"as b}from"y";']])(
    "still reads the minified import %s",
    (code) => {
      expect(importErrors({ "a/index.js": code }, FILES, ["dep"])).toEqual([
        "a/index.js imports undeclared y",
      ]);
    },
  );

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

describe("export targets", () => {
  it("names every condition of every subpath, at any depth", () => {
    const exports = {
      ".": { types: "./a.d.ts", default: "./a.js" },
      "./b": { node: { import: "./b.js" }, default: "./c.js" },
      "./d": "./d.js",
    };
    expect(exportTargets(exports)).toEqual([
      [".", "./a.d.ts"],
      [".", "./a.js"],
      ["./b", "./b.js"],
      ["./b", "./c.js"],
      ["./d", "./d.js"],
    ]);
    expect(exportTargets("./x.js")).toEqual([[".", "./x.js"]]);
  });
});

describe("npm CLI", () => {
  const host = (platform: NodeJS.Platform, execPath: string, npmExecPath?: string) => ({
    execPath,
    platform,
    npmExecPath,
    exists: (path: string) => path.endsWith("npm-cli.js"),
  });

  it("runs npm-cli.js next to node.exe on Windows, not npm.cmd", () => {
    expect(npmCliPath(host("win32", "C:\\Program Files\\nodejs\\node.exe"))).toBe(
      "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js",
    );
  });

  it("runs npm-cli.js from ../lib on POSIX", () => {
    expect(npmCliPath(host("linux", "/opt/node/bin/node"))).toBe(
      "/opt/node/lib/node_modules/npm/bin/npm-cli.js",
    );
  });

  it("prefers npm's own npm_execpath, never pnpm's", () => {
    const npm = "C:\\npm\\bin\\npm-cli.js";
    expect(npmCliPath(host("win32", "C:\\nodejs\\node.exe", npm))).toBe(npm);
    expect(npmCliPath(host("win32", "C:\\nodejs\\node.exe", "C:\\pnpm\\pnpm.cjs"))).toBe(
      "C:\\nodejs\\node_modules\\npm\\bin\\npm-cli.js",
    );
  });

  it("fails when npm is not next to node", () => {
    expect(() => npmCliPath({ ...host("win32", "C:\\x\\node.exe"), exists: () => false })).toThrow(
      /npm CLI not found/u,
    );
  });
});

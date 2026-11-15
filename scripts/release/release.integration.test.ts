import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { checkStaged, CONTRACTS, PACKAGES, stagePackage, TEST_FAKES } from "./index.ts";
import { ROOT } from "./stage.ts";

// U10 (DAN-742): the staged packages as `npm pack` sees them. Every negative
// case stages afresh, changes one thing and expects checkStaged to name it.
// Inside the repository, so the staged test-fakes resolve oidc-provider from
// node_modules as an installed package would.
mkdirSync(join(ROOT, "dist"), { recursive: true });
const TMP = mkdtempSync(join(ROOT, "dist", "release-test-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

let run = 0;
const stage = (spec = TEST_FAKES) => stagePackage(spec, join(TMP, String((run += 1))));

/** Changes the staged package.json of `dir` with `change`. */
function editManifest(dir: string, change: (manifest: Record<string, unknown>) => void): void {
  const path = join(dir, "package.json");
  const manifest = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  change(manifest);
  writeFileSync(path, JSON.stringify(manifest));
}

describe("staged packages", () => {
  it.each(PACKAGES)(
    "$name has exactly its files, a fit manifest, no secret and its guard",
    (spec) => {
      expect(checkStaged(spec, stage(spec))).toEqual([]);
    },
    60_000,
  );

  // npm packs only what "files" names, so a wrong list is how an extra file
  // gets in: the file is added and listed, and the check must still refuse it.
  it.each([
    [".env", "NAME=x\n"],
    ["server/http/x.js", "export {};\n"],
    ["db/main/migrations/1_x.sql", "select 1;\n"],
    ["packages/test-fakes/clock/clock.test.ts", "export {};\n"],
  ])(
    "refuses an extra %s",
    (path, text) => {
      const dir = stage(CONTRACTS);
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
      editManifest(dir, (manifest) => {
        manifest.files = [...(manifest.files as string[]), path];
      });
      expect(checkStaged(CONTRACTS, dir)).toContain(`@ductura/contracts: unexpected file ${path}`);
    },
    60_000,
  );

  it("refuses a missing file", () => {
    const dir = stage(CONTRACTS);
    rmSync(join(dir, "openapi", "v1.json"));
    expect(checkStaged(CONTRACTS, dir)).toContain(
      "@ductura/contracts: missing file openapi/v1.json",
    );
  }, 60_000);

  it("refuses a private key in a listed file", () => {
    const dir = stage(CONTRACTS);
    writeFileSync(join(dir, "README.md"), "-----BEGIN PRIVATE KEY-----\n");
    expect(checkStaged(CONTRACTS, dir)).toContain("@ductura/contracts: private key in README.md");
  }, 60_000);

  it("refuses a manifest marked private", () => {
    const dir = stage(CONTRACTS);
    editManifest(dir, (manifest) => {
      manifest.private = true;
    });
    expect(checkStaged(CONTRACTS, dir).join("\n")).toMatch(/private is set/u);
  }, 60_000);

  it("refuses a test-fakes root that loads in production", () => {
    const dir = stage();
    writeFileSync(join(dir, "packages/test-fakes/release.js"), "export const x = 1;\n");
    expect(checkStaged(TEST_FAKES, dir)).toContain(
      "@ductura/test-fakes: packages/test-fakes/release.ts loads with NODE_ENV=production",
    );
  }, 120_000);
});

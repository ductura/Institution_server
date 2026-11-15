// DAN-759: the state file names the repository SHA and the package versions.
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import {
  packageVersions,
  readState,
  repoRevision,
  type StackState,
  VERSIONED,
  writeState,
} from "./index.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "ductura-stack-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("state", () => {
  it("reads the installed version of every listed package and node", () => {
    const versions = packageVersions(ROOT);
    expect(Object.keys(versions).sort()).toEqual([...VERSIONED, "node"].sort());
    for (const version of Object.values(versions)) expect(version).toMatch(/^v?\d+\.\d+\.\d+/u);
  });

  it("refuses a root without the manifests", () => {
    expect(() => packageVersions(dir)).toThrow();
  });

  it("names HEAD as a full SHA", () => {
    expect(repoRevision(ROOT).sha).toMatch(/^[0-9a-f]{40}$/u);
  });

  it("writes a 0600 file and reads it back; a missing file is no state", () => {
    const file = join(dir, "state.json");
    expect(readState(file)).toBeNull();
    const state: StackState = {
      env: "ci",
      startedAt: "2026-01-01T00:00:00.000Z",
      repo: { sha: "0".repeat(40), dirty: false },
      versions: { node: "v24.0.0" },
      serverBuildSha256: "a".repeat(64),
      ports: { postgres: 54360, server: 4100, oidc: 4180 },
      processes: { server: { pid: 1234, marker: "/r/dist/server.js" } },
      pgdata: "/r/.stack/vs1/pgdata",
    };
    writeState(file, state);
    expect(readState(file)).toEqual(state);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});

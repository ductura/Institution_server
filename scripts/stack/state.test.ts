// DAN-759: the state file names the repository SHA and the package versions.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import {
  packageVersions,
  postgresVersion,
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

  it("lists the server package under its renamed name, written out literally", () => {
    expect(VERSIONED).toContain("@ductura/institution-server");
    expect(VERSIONED).not.toContain("@ductura/server");
    expect(Object.keys(packageVersions(ROOT))).toContain("@ductura/institution-server");
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
      repos: { server: { sha: "0".repeat(40), dirty: false }, preloader: null, web: null },
      versions: { node: "v24.0.0" },
      serverBuildSha256: "a".repeat(64),
      ports: { postgres: 54360, server: 4100, oidc: 4180, s3: 4191 },
      processes: {
        server: { pid: 1234, marker: "/r/dist/server.js" },
        oidc: { pid: 1235, marker: "/r/node /r/packages/test-fakes/oidc/server.ts" },
      },
      pgdata: "/r/.stack/vs1/pgdata",
    };
    writeState(file, state);
    expect(readState(file)).toEqual(state);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(existsSync(`${file}.tmp`)).toBe(false);
  });

  it.each([
    ["{}"],
    ["[]"],
    ["null"],
    ["42"],
    ['{"ports": {}, "processes": {}}'],
    ['{"ports": {"postgres": 54360, "server": 4100, "oidc": 4180, "s3": 4191}, "processes": null}'],
    ['{"ports": {"postgres": 54360, "server": "4100", "oidc": 4180, "s3": 4191}, "processes": {}}'],
    [
      '{"ports": {"postgres": 54360, "server": 4100, "oidc": 4180, "s3": 4191}, "processes": {"server": {"pid": "1"}}}',
    ],
    [
      '{"ports": {"postgres": 54360, "server": 4100, "oidc": 4180, "s3": 4191}, "processes": {"oidc": {"pid": 1}}}',
    ],
    // DAN-787: a port of another stack is never ours, so status and down never ask it.
    ['{"ports": {"postgres": 54360, "server": 3000, "oidc": 4180, "s3": 4191}, "processes": {}}'],
    ['{"ports": {"postgres": 3004, "server": 4100, "oidc": 4180, "s3": 4191}, "processes": {}}'],
    // DAN-817: the local S3 port follows the same rules, and must be there.
    ['{"ports": {"postgres": 54360, "server": 4100, "oidc": 4180, "s3": 3000}, "processes": {}}'],
    ['{"ports": {"postgres": 54360, "server": 4100, "oidc": 4180, "s3": "4191"}, "processes": {}}'],
    ['{"ports": {"postgres": 54360, "server": 4100, "oidc": 4180}, "processes": {}}'],
    [
      '{"ports": {"postgres": 54360, "server": 4100, "oidc": 4180, "s3": 4191}, "processes": {"s3": {"pid": 1}}}',
    ],
    // QA c.6900731697: an extra key would be a port down probes.
    [
      '{"ports": {"postgres": 54360, "server": 4100, "oidc": 4180, "s3": 4191, "web": 3000}, "processes": {}}',
    ],
    [
      '{"ports": {"postgres": 54360, "server": 4100, "oidc": 4180, "s3": 4191}, "processes": {"web": {"pid": 2, "marker": "x"}}}',
    ],
  ])("calls the JSON %s unreadable, not a state", (text) => {
    const file = join(dir, "shape.json");
    writeFileSync(file, text);
    expect(readState(file)).toBe("unreadable");
  });

  it("calls a truncated file unreadable instead of throwing", () => {
    const file = join(dir, "broken.json");
    writeFileSync(file, '{"env": "ci", "ports": {');
    expect(readState(file)).toBe("unreadable");
  });
});

describe("readState of what is not a regular file (DAN-787)", () => {
  it("calls a FIFO unreadable instead of blocking on it", () => {
    const fifo = join(dir, "fifo.json");
    expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
    expect(readState(fifo)).toBe("unreadable");
  });

  it("calls a link and an oversized file unreadable", () => {
    const big = join(dir, "big.json");
    writeFileSync(big, " ".repeat(70_000));
    expect(readState(big)).toBe("unreadable");
    symlinkSync(big, join(dir, "link.json"));
    expect(readState(join(dir, "link.json"))).toBe("unreadable");
  });
});

describe("postgresVersion (DAN-787)", () => {
  function fakePostgres(output: string): string {
    const bin = mkdtempSync(join(dir, "bin-"));
    writeFileSync(join(bin, "postgres"), `#!/bin/sh\necho '${output}'\n`);
    chmodSync(join(bin, "postgres"), 0o755);
    return bin;
  }

  it("reads the version the postgres on PATH names", () => {
    expect(postgresVersion(fakePostgres("postgres (PostgreSQL) 17.2"))).toBe("17.2");
  });

  it("refuses an answer without a version", () => {
    expect(() => postgresVersion(fakePostgres("something else"))).toThrow(/no version/u);
  });
});

describe("a state with the local S3 (DAN-817)", () => {
  it("is read back whole, its s3 process included, so down can stop it", () => {
    const dir = mkdtempSync(join(tmpdir(), "vs1-state-s3-"));
    try {
      const file = join(dir, "state.json");
      const text =
        '{"ports": {"postgres": 54360, "server": 4100, "oidc": 4180, "s3": 4191}, "processes": {"s3": {"pid": 7, "marker": "/n /r/scripts/stack/local-s3.ts --vs1-stack=/r"}}}';
      writeFileSync(file, text);
      const read = readState(file);
      expect(read).not.toBe("unreadable");
      expect(read === null || read === "unreadable" ? null : read.processes.s3).toEqual({
        pid: 7,
        marker: "/n /r/scripts/stack/local-s3.ts --vs1-stack=/r",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

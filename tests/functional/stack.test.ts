// DAN-1003 (review on ductura/server#276): the functional test reaches only
// the stack it was given, by the stack's own directory rules and never
// through a link; each refusal comes before any read of state or database.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { runningStack } from "./index.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/u, "");
const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("runningStack", () => {
  it.each([
    ["a relative path", "tmp/vs1"],
    ["a path with ..", "/tmp/a/../b"],
    ["a path outside .stack/ and /tmp", "/home/vs1"],
    ["a path with a space", "/tmp/vs 1"],
    ["a path with a newline", "/tmp/vs1\n"],
    ["a trailing slash", "/tmp/vs1/"],
  ])("refuses %s", (_name, given) => {
    expect(() => runningStack(given, ROOT)).toThrow(/stack directory/u);
  });

  it("refuses a stack directory reached through a link", () => {
    const other = mkdtempSync("/tmp/vs1-other-");
    const link = `${other}-link`;
    made.push(other, link);
    symlinkSync(other, link);
    expect(() => runningStack(link, ROOT)).toThrow(/through a link/u);
  });

  it("refuses a directory that holds no running stack", () => {
    const dir = mkdtempSync("/tmp/vs1-empty-");
    made.push(dir);
    mkdirSync(join(dir, "pgdata"));
    expect(() => runningStack(dir, ROOT)).toThrow(/not up/u);
  });
});

// VS-1.13 (A06): the files through which a test restarts the server under
// `pnpm lokalno` (nadzor.ts).
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clearSupervisorFiles,
  readSupervisorState,
  START_FILE,
  STOP_FILE,
  SUPERVISOR_FILE,
  supervisorState,
  takeStopRequest,
  waitForStartRequest,
  writeSupervisorState,
} from "./nadzor.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nadzor-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("nadzor.json", () => {
  it("holds PIDs, the command line and the directory, nothing from the environment", () => {
    const state = supervisorState(10, { pid: 11, argv: ["node", "dist/server.js"], cwd: "/srv" });
    writeSupervisorState(dir, state);
    const raw = JSON.parse(readFileSync(join(dir, SUPERVISOR_FILE), "utf8"));
    expect(Object.keys(raw).sort()).toEqual(["protocol", "server", "supervisor"]);
    expect(Object.keys(raw.server).sort()).toEqual(["argv", "cwd", "pid"]);
    expect(readSupervisorState(dir)).toEqual(state);
  });

  it("reads null for a missing, broken or foreign file", () => {
    expect(readSupervisorState(dir)).toBeNull();
    writeFileSync(join(dir, SUPERVISOR_FILE), "{");
    expect(readSupervisorState(dir)).toBeNull();
    writeFileSync(
      join(dir, SUPERVISOR_FILE),
      JSON.stringify({ protocol: 2, supervisor: 1, server: { pid: 2 } }),
    );
    expect(readSupervisorState(dir)).toBeNull();
  });
});

describe("planned stop and start", () => {
  it("an exit without the stop request is not planned", () => {
    expect(takeStopRequest(dir)).toBe(false);
  });

  it("one stop request covers one exit", () => {
    writeFileSync(join(dir, STOP_FILE), "");
    expect(takeStopRequest(dir)).toBe(true);
    expect(takeStopRequest(dir)).toBe(false);
  });

  it("waits for the start request and consumes it", async () => {
    setTimeout(() => writeFileSync(join(dir, START_FILE), ""), 50);
    await expect(waitForStartRequest(dir, 2_000, 10)).resolves.toBe(true);
    expect(existsSync(join(dir, START_FILE))).toBe(false);
  });

  it("gives up when no start request comes", async () => {
    await expect(waitForStartRequest(dir, 60, 10)).resolves.toBe(false);
  });

  it("the supervisor leaves no files behind", () => {
    for (const name of [SUPERVISOR_FILE, STOP_FILE, START_FILE]) writeFileSync(join(dir, name), "");
    clearSupervisorFiles(dir);
    for (const name of [SUPERVISOR_FILE, STOP_FILE, START_FILE])
      expect(existsSync(join(dir, name))).toBe(false);
  });
});

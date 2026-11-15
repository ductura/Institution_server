// DAN-759: one `up` at a time, and a stale lock is taken over by one process only.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { clearStaleLock, commandLine, takeLock } from "./index.ts";

const dir = mkdtempSync(join(tmpdir(), "ductura-lock-"));
const file = join(dir, "up.lock");
afterAll(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  rmSync(file, { force: true });
  rmSync(`${file}.takeover`, { recursive: true, force: true });
});

const dead = (): boolean => false;
const alive = (): boolean => true;

describe("takeLock", () => {
  it("creates the lock with this pid", () => {
    takeLock(file, dead);
    expect(readFileSync(file, "utf8").split("\n")[0]).toBe(String(process.pid));
  });

  it("refuses while the owner runs and leaves its lock", () => {
    writeFileSync(file, "4242");
    expect(() => takeLock(file, alive)).toThrow(/pid 4242/u);
    expect(readFileSync(file, "utf8")).toBe("4242");
    expect(existsSync(`${file}.takeover`)).toBe(false);
  });

  it("takes over a lock whose owner no longer runs", () => {
    writeFileSync(file, "4242");
    takeLock(file, (pid) => pid !== 4242);
    expect(readFileSync(file, "utf8").split("\n")[0]).toBe(String(process.pid));
  });

  it("refuses while another process holds the takeover, and changes nothing", () => {
    writeFileSync(file, "4242");
    mkdirSync(`${file}.takeover`);
    expect(() => takeLock(file, dead)).toThrow(/taking over/u);
    expect(readFileSync(file, "utf8")).toBe("4242");
  });

  it("lets only one of two racing takeovers win", () => {
    writeFileSync(file, "4242");
    // A second process tries while the first holds the takeover and is still
    // checking the stale owner: it must fail rather than replace the lock too.
    let second: unknown = null;
    takeLock(file, (pid) => {
      if (pid === 4242) {
        try {
          takeLock(file, dead);
        } catch (error) {
          second = error;
        }
        return false;
      }
      return true;
    });
    expect(second).toBeInstanceOf(Error);
    expect(readFileSync(file, "utf8").split("\n")[0]).toBe(String(process.pid));
    expect(() => takeLock(file, (pid) => pid === process.pid)).toThrow(/is running/u);
  });
});

describe("takeLock with the real owner check", () => {
  it("records this pid and command line, and refuses a second take while this process runs", () => {
    takeLock(file);
    const [pid, line] = readFileSync(file, "utf8").split("\n");
    expect(pid).toBe(String(process.pid));
    expect(line).toBe(commandLine(process.pid));
    // However the owner was started (pnpm, a relative path), its own line matches.
    expect(() => takeLock(file)).toThrow(/is running/u);
  });

  it("takes over a lock whose pid now runs another command", () => {
    writeFileSync(file, `${process.pid}\nnode /elsewhere/scripts/stack/vs1.ts up\n`);
    takeLock(file);
    expect(readFileSync(file, "utf8").split("\n")[1]).toBe(commandLine(process.pid));
  });

  it("takes over a lock with no command line", () => {
    writeFileSync(file, `${process.pid}\n`);
    takeLock(file);
    expect(readFileSync(file, "utf8").split("\n")[0]).toBe(String(process.pid));
  });
});

describe("clearStaleLock", () => {
  it("is true with nothing to clear and removes a dead owner's lock", () => {
    expect(clearStaleLock(file, dead)).toBe(true);
    writeFileSync(file, "4242");
    expect(clearStaleLock(file, dead)).toBe(true);
    expect(existsSync(file)).toBe(false);
  });

  it("is false while another process holds the takeover", () => {
    writeFileSync(file, "4242");
    mkdirSync(`${file}.takeover`);
    expect(clearStaleLock(file, dead)).toBe(false);
    expect(existsSync(file)).toBe(true);
  });
});

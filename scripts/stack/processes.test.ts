// DAN-759: `down` signals only the processes the stack started, and only while
// the recorded id still runs the recorded command.
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { describe, expect, it } from "vitest";

import { commandLine, portFree, stopProcess, waitHealthy } from "./index.ts";

const noWait = async (): Promise<void> => {};

function fakeProcess(lines: (string | null)[]): {
  command: (pid: number) => string | null;
  kill: (pid: number, signal: NodeJS.Signals) => void;
  signals: string[];
} {
  const signals: string[] = [];
  let index = 0;
  return {
    signals,
    command: () => lines[Math.min(index++, lines.length - 1)] ?? null,
    kill: (pid, signal) => signals.push(`${pid}:${signal}`),
  };
}

describe("stopProcess", () => {
  it("sends SIGTERM to a process that still runs the marker", async () => {
    const fake = fakeProcess(["/r/dist/server.js", "/r/dist/server.js", null]);
    expect(await stopProcess(4242, "/r/dist/server.js", 1000, { ...fake, wait: noWait })).toBe(
      "stopped",
    );
    expect(fake.signals).toEqual(["4242:SIGTERM"]);
  });

  it("sends SIGKILL after the grace period", async () => {
    const fake = fakeProcess(["/r/dist/server.js"]);
    await stopProcess(4242, "/r/dist/server.js", 300, { ...fake, wait: noWait });
    expect(fake.signals).toEqual(["4242:SIGTERM", "4242:SIGKILL"]);
  });

  it("treats a defunct process as stopped", async () => {
    const fake = fakeProcess(["/r/dist/server.js", "[node] <defunct>"]);
    expect(await stopProcess(4242, "/r/dist/server.js", 1000, { ...fake, wait: noWait })).toBe(
      "stopped",
    );
    expect(fake.signals).toEqual(["4242:SIGTERM"]);
  });

  it("leaves a process that only mentions the marker alone", async () => {
    const fake = fakeProcess(["tail -f /r/dist/server.js"]);
    expect(await stopProcess(4242, "/r/dist/server.js", 1000, { ...fake, wait: noWait })).toBe(
      "foreign",
    );
    expect(fake.signals).toEqual([]);
  });

  it("leaves a reused id alone", async () => {
    const fake = fakeProcess(["postgres: another stack"]);
    expect(await stopProcess(4242, "/r/dist/server.js", 1000, { ...fake, wait: noWait })).toBe(
      "foreign",
    );
    expect(fake.signals).toEqual([]);
  });

  it("reports a process that already exited", async () => {
    const fake = fakeProcess([null]);
    expect(await stopProcess(4242, "/r/dist/server.js", 1000, { ...fake, wait: noWait })).toBe(
      "gone",
    );
    expect(fake.signals).toEqual([]);
  });

  it.each([0, 1, -5, 1.5, Number.NaN])("never signals the id %s", async (pid) => {
    const fake = fakeProcess(["/r/dist/server.js"]);
    expect(await stopProcess(pid, "/r/dist/server.js", 1000, { ...fake, wait: noWait })).toBe(
      "foreign",
    );
    expect(fake.signals).toEqual([]);
  });
});

describe("stopProcess with the real signal", () => {
  it("counts a process group that is already gone as stopped", async () => {
    // A child that has exited and was reaped: its id names no process group,
    // so the signal gets ESRCH, as when the server exits right after the check.
    const gone = spawnSync(process.execPath, ["-e", ""]).pid;
    let calls = 0;
    const command = (): string | null => (calls++ < 1 ? "/r/dist/server.js" : null);
    await expect(
      stopProcess(gone, "/r/dist/server.js", 1000, { command, wait: noWait }),
    ).resolves.toBe("stopped");
  });
});

describe("commandLine", () => {
  it("reads the whole command line, whatever COLUMNS says", () => {
    const saved = process.env.COLUMNS;
    process.env.COLUMNS = "20";
    try {
      const line = commandLine(process.pid) ?? "";
      expect(line.length).toBeGreaterThan(20);
      expect(line.startsWith(process.execPath)).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.COLUMNS;
      else process.env.COLUMNS = saved;
    }
  });

  it("is null for a process that does not exist", () => {
    expect(commandLine(2 ** 22 + 7)).toBeNull();
  });
});

describe("waitHealthy", () => {
  it("answers true on the first 200", async () => {
    const statuses = [503, 503, 200];
    const get = (async () =>
      new Response(null, { status: statuses.shift() ?? 500 })) as typeof fetch;
    expect(await waitHealthy("http://127.0.0.1:1/api/v1/health", 5000, { get, wait: noWait })).toBe(
      true,
    );
    expect(statuses).toEqual([]);
  });

  it("answers false when the deadline passes", async () => {
    const get = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    expect(await waitHealthy("http://127.0.0.1:1/api/v1/health", 1000, { get, wait: noWait })).toBe(
      false,
    );
  });
});

describe("portFree", () => {
  it("tells a listening port from a closed one", async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    expect(await portFree(port)).toBe(false);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(await portFree(port)).toBe(true);
  });
});

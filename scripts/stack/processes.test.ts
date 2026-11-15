// DAN-759: `down` signals only the processes the stack started, and only while
// the recorded id still runs the recorded command.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { describe, expect, it } from "vitest";

import { portFree, stopProcess, waitHealthy } from "./index.ts";

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
    const fake = fakeProcess(["node /r/dist/server.js", "node /r/dist/server.js", null]);
    expect(await stopProcess(4242, "/r/dist/server.js", 1000, { ...fake, wait: noWait })).toBe(
      "stopped",
    );
    expect(fake.signals).toEqual(["4242:SIGTERM"]);
  });

  it("sends SIGKILL after the grace period", async () => {
    const fake = fakeProcess(["node /r/dist/server.js"]);
    await stopProcess(4242, "/r/dist/server.js", 300, { ...fake, wait: noWait });
    expect(fake.signals).toEqual(["4242:SIGTERM", "4242:SIGKILL"]);
  });

  it("treats a defunct process as stopped", async () => {
    const fake = fakeProcess(["node /r/dist/server.js", "[node] <defunct>"]);
    expect(await stopProcess(4242, "/r/dist/server.js", 1000, { ...fake, wait: noWait })).toBe(
      "stopped",
    );
    expect(fake.signals).toEqual(["4242:SIGTERM"]);
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
    const fake = fakeProcess(["node /r/dist/server.js"]);
    expect(await stopProcess(pid, "/r/dist/server.js", 1000, { ...fake, wait: noWait })).toBe(
      "foreign",
    );
    expect(fake.signals).toEqual([]);
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

// DAN-759: `down` signals only the processes the stack started, and only while
// the recorded id still runs the recorded command.
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { describe, expect, it } from "vitest";

import {
  commandLine,
  isStackPostmaster,
  tailLines,
  listensOn,
  portFree,
  postgresOptions,
  serverReady,
  stopProcess,
  waitHealthy,
} from "./index.ts";

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

  it("does not SIGKILL an id that another process took during the last wait", async () => {
    const fake = fakeProcess(["/r/dist/server.js", "/r/dist/server.js", "sleep 600"]);
    expect(await stopProcess(4242, "/r/dist/server.js", 100, { ...fake, wait: noWait })).toBe(
      "stopped",
    );
    expect(fake.signals).toEqual(["4242:SIGTERM"]);
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

describe("isStackPostmaster", () => {
  const pgdata = "/r/.stack/vs1/pgdata";
  const dir = "/r/.stack/vs1";
  const ours = `/usr/lib/postgresql/17/bin/postgres -D ${pgdata} ${postgresOptions(54360, dir)}`;

  it("accepts the postmaster pg_ctl starts", () => {
    expect(isStackPostmaster(ours, pgdata, dir, 54360)).toBe(true);
  });

  it.each([
    [
      "a process that only carries -D <pgdata> among its arguments",
      `node /tmp/x.js -- -D ${pgdata} extra`,
    ],
    [
      "the same arguments after another program",
      `/usr/bin/sleep -D ${pgdata} ${postgresOptions(54360, dir)}`,
    ],
    ["a relative postgres", `postgres -D ${pgdata} ${postgresOptions(54360, dir)}`],
    [
      "a wrapper before postgres",
      `/bin/sh -c /usr/lib/postgresql/17/bin/postgres -D ${pgdata} ${postgresOptions(54360, dir)}`,
    ],
    ["another data directory", ours.replace(pgdata, "/other/pgdata")],
    ["extra arguments", `${ours} -c x=1`],
    ["an empty line", ""],
  ])("refuses %s", (_, line) => {
    expect(isStackPostmaster(line, pgdata, dir, 54360)).toBe(false);
  });

  it("refuses our postmaster line for another port", () => {
    expect(isStackPostmaster(ours, pgdata, dir, 54361)).toBe(false);
  });
});

describe("listensOn and serverReady", () => {
  const listen = async (pathOk: boolean): Promise<{ port: number; close: () => Promise<void> }> => {
    const server = createServer((_, response) => response.writeHead(pathOk ? 200 : 503).end());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    return { port, close: () => new Promise((resolve) => server.close(() => resolve())) };
  };

  it("sees the port this process listens on, and no other", async () => {
    const own = await listen(true);
    try {
      expect(listensOn(process.pid, own.port)).toBe(true);
      expect(listensOn(process.pid, own.port === 65_535 ? 65_534 : own.port + 1)).toBe(false);
    } finally {
      await own.close();
    }
    expect(listensOn(process.pid, own.port)).toBe(false);
  });

  it("is not ready when a foreign process answers 200 on the port and ours does not listen", async () => {
    // "Foreign": this test process answers health; "ours": a child that never listens.
    const foreign = await listen(true);
    const ours = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
      stdio: "ignore",
    });
    try {
      await new Promise((resolve) => ours.once("spawn", resolve));
      const url = `http://127.0.0.1:${foreign.port}/api/v1/health`;
      expect(await serverReady(url, ours.pid as number, foreign.port, 2000)).toBe(false);
      expect(await serverReady(url, process.pid, foreign.port, 2000)).toBe(true);
    } finally {
      ours.kill("SIGKILL");
      await foreign.close();
    }
  });
});

describe("waitHealthy", () => {
  it("answers true on the first 200", async () => {
    const statuses = [503, 503, 200];
    const get = (async () =>
      new Response(null, { status: statuses.shift() ?? 500 })) as typeof fetch;
    expect(await waitHealthy("http://127.0.0.1:1/api/v1/health", 5000, get, noWait)).toBe(true);
    expect(statuses).toEqual([]);
  });

  it("answers false when the deadline passes", async () => {
    const get = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    expect(await waitHealthy("http://127.0.0.1:1/api/v1/health", 1000, get, noWait)).toBe(false);
  });
});

describe("waitHealthy deadline (DAN-787)", () => {
  it("counts the time requests hang, not only the pauses", async () => {
    let clock = 0;
    let calls = 0;
    // Every request hangs one second on the clock and then fails.
    const get = (async () => {
      calls += 1;
      clock += 1000;
      throw new Error("timeout");
    }) as typeof fetch;
    const wait = async (ms: number): Promise<void> => {
      clock += ms;
    };
    expect(await waitHealthy("http://127.0.0.1:1/", 5000, get, wait, () => clock)).toBe(false);
    expect(clock).toBeLessThanOrEqual(5000);
    expect(calls).toBeLessThanOrEqual(5);
  });

  it("follows no redirect", async () => {
    const seen: (string | undefined)[] = [];
    const get = (async (_: string, init?: RequestInit) => {
      seen.push(init?.redirect);
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    expect(await waitHealthy("http://127.0.0.1:1/", 1000, get, noWait)).toBe(true);
    expect(seen).toEqual(["manual"]);
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

describe("tailLines", () => {
  it("keeps only the last lines and drops empty ones", () => {
    expect(tailLines("a\nb\n\nc\nd\n", 2)).toBe("c\nd");
    expect(tailLines("a\nb\n", 100)).toBe("a\nb");
    expect(tailLines("", 5)).toBe("");
  });
});

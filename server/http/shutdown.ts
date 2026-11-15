// Graceful shutdown of the server (S-1B-c, DAN-778); port of Ductus
// src/server/shutdown.ts at d52a92c3 (DAN-587) without the worker's jobs.
//
// The coordinator holds no I/O: a request in flight takes a ticket, stop()
// waits for every ticket issued before it until the deadline, and after stop()
// no new ticket is issued. The check and the count happen in one synchronous
// step, so on the single JS thread there is no gap between them.
//
// installShutdown orders the rest from the first SIGTERM or SIGINT: stop
// accepting, wait for the started requests, then the hooks one by one (logs,
// then databases), then exit. One deadline from that signal covers all of it.
import { logEvent } from "../log/index.ts";

/** Default deadline: under the 10 s a container stop waits before SIGKILL. */
export const SHUTDOWN_GRACE_MS = 8_000;

export type ShutdownState = "running" | "draining" | "stopped";
export type StopResult = { outcome: "drained" } | { outcome: "deadline"; unfinished: number };
export type Ticket = { release(): void };
export type Clock = {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

export type ShutdownCoordinator = {
  readonly graceMs: number;
  state(): ShutdownState;
  /** Requests holding a ticket. */
  active(): number;
  /** A ticket for a request that starts now, or null once stop() was called. */
  begin(): Ticket | null;
  /** Idempotent: every call returns the same promise. */
  stop(): Promise<StopResult>;
};

const realClock: Clock = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function createShutdownCoordinator(
  options: { graceMs?: number; clock?: Clock } = {},
): ShutdownCoordinator {
  const graceMs = options.graceMs ?? SHUTDOWN_GRACE_MS;
  const clock = options.clock ?? realClock;
  let count = 0;
  let current: ShutdownState = "running";
  let stopping: Promise<StopResult> | undefined;
  let settle: ((result: StopResult) => void) | undefined;
  let deadline: unknown;

  const finish = (result: StopResult) => {
    const resolve = settle;
    if (!resolve) return;
    settle = undefined;
    clock.clearTimeout(deadline);
    current = "stopped";
    resolve(result);
  };
  const drainedIfIdle = () => {
    if (count === 0) finish({ outcome: "drained" });
  };

  return {
    graceMs,
    state: () => current,
    active: () => count,
    begin() {
      if (current !== "running") return null;
      count += 1;
      let open = true;
      return {
        release() {
          if (!open) return;
          open = false;
          count -= 1;
          drainedIfIdle();
        },
      };
    },
    stop() {
      if (stopping) return stopping;
      current = "draining";
      stopping = new Promise<StopResult>((resolve) => (settle = resolve));
      deadline = clock.setTimeout(
        () => finish({ outcome: "deadline", unfinished: count }),
        graceMs,
      );
      drainedIfIdle();
      return stopping;
    },
  };
}

export type SignalTarget = {
  on(signal: "SIGTERM" | "SIGINT", listener: () => void): unknown;
  off(signal: "SIGTERM" | "SIGINT", listener: () => void): unknown;
};

/** One step after the requests; a throw or a hang is a failed shutdown. */
export type ShutdownHook = { readonly name: string; run(): Promise<void> | void };

/** The part of the HTTP server shutdown needs (server/http/start.ts, Running). */
export type Listener = { stopAccepting(): void; closeAllConnections(): void };

export type ShutdownLog = (event: string, fields: Record<string, unknown>) => void;

const SIGNALS = ["SIGTERM", "SIGINT"] as const;

/** The name of a thrown value, never its message (it may carry a token). */
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** Waits until stdout and stderr have taken every line written so far. */
export const FLUSH_LOGS: ShutdownHook = {
  name: "logs",
  run: async () => {
    await Promise.all(
      [process.stdout, process.stderr].map(
        (stream) => new Promise<void>((resolve) => stream.write("", () => resolve())),
      ),
    );
  },
};

/**
 * The first SIGTERM or SIGINT starts the shutdown; later signals start
 * nothing new and do not shorten the deadline. Exit 0 only when every started
 * request finished and every hook returned within the deadline; otherwise 1,
 * with one log line that names the phase, never a message or a request.
 */
export function installShutdown(
  target: SignalTarget,
  options: {
    coordinator: ShutdownCoordinator;
    listener: Listener;
    hooks: readonly ShutdownHook[];
    exit: (code: number) => unknown;
    clock?: Clock;
    log?: ShutdownLog;
  },
): () => void {
  const { coordinator, listener, hooks } = options;
  const clock = options.clock ?? realClock;
  const log = options.log ?? ((event, fields) => logEvent("error", event, fields));
  let signalled = false;
  let ended = false;
  let phase: "requests" | "hooks" = "requests";
  let hook: string | undefined;
  let timer: unknown;

  const end = (code: 0 | 1) => {
    if (ended) return;
    ended = true;
    clock.clearTimeout(timer);
    options.exit(code);
  };
  const expire = (requests: number) => {
    if (ended) return;
    log("shutdown.deadline", { phase, ...(hook === undefined ? {} : { hook }), requests });
    listener.closeAllConnections();
    end(1);
  };
  const run = async () => {
    const result = await coordinator.stop();
    if (result.outcome === "deadline") return expire(result.unfinished);
    phase = "hooks";
    let failed = false;
    for (const next of hooks) {
      if (ended) return;
      hook = next.name;
      try {
        await next.run();
      } catch (error) {
        failed = true;
        log("shutdown.hook_failed", { hook: next.name, error: errorName(error) });
      }
    }
    hook = undefined;
    end(failed ? 1 : 0);
  };
  const onSignal = () => {
    if (signalled) return;
    signalled = true;
    timer = clock.setTimeout(() => expire(coordinator.active()), coordinator.graceMs);
    void run().catch((error: unknown) => {
      log("shutdown.failed", { error: errorName(error) });
      end(1);
    });
    listener.stopAccepting();
  };
  for (const signal of SIGNALS) target.on(signal, onSignal);
  return () => {
    for (const signal of SIGNALS) target.off(signal, onSignal);
  };
}

// Readiness core (S-1E-d, DAN-839-1; port of Ductus src/server/ready.ts at
// 393b8e0, checkCapabilities): the probes run in parallel, each with its own
// limit inside one total limit, and each answer is judged by when it ended.
// Only closed words of the ready contract and codes of a limited shape come
// out, never a message. The route (839-2) and the real probes (839-3) follow.
export type ReadyCapabilityName = "database" | "storage" | "signing" | "queue";
export type ReadyStatus = "ok" | "nedostupno" | "nije_konfigurirano";
/** Answers "ok" or "nije_konfigurirano"; anything else, a throw or no answer in time is "nedostupno". */
export type ReadyProbe = (signal: AbortSignal) => Promise<"ok" | "nije_konfigurirano">;
export type ReadyCapability = {
  readonly name: ReadyCapabilityName;
  readonly required: boolean;
  readonly timeoutMs: number;
  readonly probe: ReadyProbe;
};
export type ReadyReport = {
  /** False exactly when a required capability is not "ok". */
  ready: boolean;
  capabilities: Partial<Record<ReadyCapabilityName, ReadyStatus>>;
  /** Codes of the failed capabilities, for the log only. */
  codes: Partial<Record<ReadyCapabilityName, string>>;
};
export type ReadyCheckOptions = {
  readonly totalMs?: number;
  /** Monotonic milliseconds; performance.now by default. */
  readonly now?: () => number;
  /** Resolves after `ms`, rejects on abort; an unref'd timer by default. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
};

/** Longest wait for the whole check. A readiness check that hangs is worse than a refusal. */
export const READY_TIMEOUT_MS = 3_000;

const NAMES: ReadonlySet<string> = new Set(["database", "storage", "signing", "queue"]);
const KEYS = ["name", "probe", "required", "timeoutMs"].join();
const MAX_TIMER_MS = 2 ** 31 - 1;
const CODE = /^[A-Za-z0-9_]{1,32}$/;
const TIMEOUT: unique symbol = Symbol("timeout");

function limit(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_TIMER_MS)
    throw new RangeError(`${what} must be a whole number of ms in [1, ${MAX_TIMER_MS}]`);
  return value;
}

/** Own data keys only, exactly the four, of a plain record. */
function capabilityOf(entry: unknown, seen: Set<string>): ReadyCapability {
  const proto: unknown =
    typeof entry === "object" && entry !== null ? Object.getPrototypeOf(entry) : undefined;
  if (proto !== Object.prototype && proto !== null)
    throw new RangeError("a capability is a plain record");
  const record = entry as object;
  const keys = Reflect.ownKeys(record);
  if (keys.map(String).sort().join() !== KEYS)
    throw new RangeError("a capability has exactly four keys");
  const field = (key: string): unknown => {
    const found = Object.getOwnPropertyDescriptor(record, key);
    if (found === undefined || !("value" in found))
      throw new RangeError(`${key} is a data property`);
    return found.value;
  };
  const name = field("name");
  if (typeof name !== "string" || !NAMES.has(name) || seen.has(name))
    throw new RangeError("a capability name is closed and given once");
  seen.add(name);
  const required = field("required");
  const probe = field("probe");
  if (typeof required !== "boolean" || typeof probe !== "function")
    throw new RangeError("required is a boolean and probe a function");
  const timeoutMs = limit(field("timeoutMs"), "timeoutMs");
  return Object.freeze({
    name: name as ReadyCapabilityName,
    required,
    timeoutMs,
    probe: probe as ReadyProbe,
  });
}

/** The error's own `code` when it has the limited shape, else "ERROR"; never its message. */
function codeOf(error: unknown): string {
  try {
    if ((typeof error !== "object" && typeof error !== "function") || error === null)
      return "ERROR";
    const found = Object.getOwnPropertyDescriptor(error, "code");
    const code: unknown = found !== undefined && "value" in found ? found.value : undefined;
    return typeof code === "string" && CODE.test(code) ? code : "ERROR";
  } catch {
    return "ERROR";
  }
}

/** An unref'd timer that rejects on abort, so readiness never keeps the process up. */
function unrefSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const stop = (): void => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve();
    }, ms);
    timer.unref();
    signal.addEventListener("abort", stop, { once: true });
  });
}

type Outcome = { status: ReadyStatus; code?: string };
type Settled = { at: number } & ({ value: unknown } | { error: unknown });

/** Makes the check over a frozen copy of `capabilities`; bad input throws here, never per request. */
export function createReadyCheck(
  capabilities: readonly ReadyCapability[],
  options: ReadyCheckOptions = {},
): () => Promise<ReadyReport> {
  if (!Array.isArray(capabilities)) throw new RangeError("capabilities is an array");
  const seen = new Set<string>();
  const list = Object.freeze(capabilities.map((entry: unknown) => capabilityOf(entry, seen)));
  const totalMs = limit(options.totalMs ?? READY_TIMEOUT_MS, "totalMs");
  const now = options.now ?? (() => performance.now());
  const sleep = options.sleep ?? unrefSleep;

  const run = async (capability: ReadyCapability): Promise<Outcome> => {
    const limitMs = Math.min(capability.timeoutMs, totalMs);
    const start = now();
    // The timer starts before any probe code and has its own signal; its
    // rejection on abort is caught here.
    const timer = new AbortController();
    const expired: Promise<typeof TIMEOUT> = sleep(limitMs, timer.signal).then(
      () => TIMEOUT,
      () => TIMEOUT,
    );
    const controller = new AbortController();
    let called: Promise<unknown>;
    try {
      called = Promise.resolve(capability.probe(controller.signal));
    } catch (error) {
      called = Promise.reject(error);
    }
    const answer: Promise<Settled> = called.then(
      (value) => ({ value, at: now() }),
      (error: unknown) => ({ error, at: now() }),
    );
    try {
      let result = await Promise.race([answer, expired]);
      // An answer that ended by the limit, and the microtasks behind it, are
      // heard first: one more macrotask (as server/metrics/external-call.ts).
      if (result === TIMEOUT)
        result = await Promise.race([
          answer,
          new Promise<typeof TIMEOUT>((go) => setImmediate(go, TIMEOUT)),
        ]);
      if (result === TIMEOUT || result.at - start > limitMs)
        return { status: "nedostupno", code: "TIMEOUT" };
      if ("error" in result) return { status: "nedostupno", code: codeOf(result.error) };
      if (result.value === "ok" || result.value === "nije_konfigurirano")
        return { status: result.value };
      return { status: "nedostupno", code: "ERROR" };
    } finally {
      timer.abort();
      // Harmless after an answer; at the limit it lets the probe let go.
      controller.abort(Object.assign(new Error("readiness limit"), { code: "TIMEOUT" }));
    }
  };

  return async () => {
    const outcomes = await Promise.all(list.map(run));
    const report: ReadyReport = { ready: true, capabilities: {}, codes: {} };
    list.forEach((capability, i) => {
      const { status, code } = outcomes[i] as Outcome;
      report.capabilities[capability.name] = status;
      if (code !== undefined) report.codes[capability.name] = code;
      if (capability.required && status !== "ok") report.ready = false;
    });
    return report;
  };
}

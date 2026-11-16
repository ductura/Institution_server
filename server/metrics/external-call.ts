/**
 * One pattern for every call to an outside service (S-1E-c, DAN-837): storage,
 * keys and email. Adapters in `external/` must not import one another
 * (docs/server-map.md §2), so the pattern lives here, next to the duration and
 * outcome it measures.
 *
 * - Deadline: it starts before the service runs, and asynchronous work ends
 *   at the latest at `timeoutMs` from the start, retries included. The timer
 *   is armed before any caller code runs; a late answer is dropped and the
 *   attempt's signal is aborted. Synchronous work in an adapter cannot be
 *   interrupted: the event then carries the real duration, which may exceed
 *   `timeoutMs`, and the outcome `timeout`. The default clock is monotonic.
 * - Inputs: the service is one of a closed list; the policy is a plain record
 *   with exactly its five own whole-number keys (delays within the timer
 *   limit), kept as a frozen copy; the operation is a lower-case code; and
 *   only an own `retry: true` allows a retry.
 * - Retry: only when the caller says the operation is idempotent, and only
 *   when the pause still ends before the deadline.
 * - Availability: after `downAfter` failed calls in a row the service is
 *   `down` for `downForMs` and calls do not reach it; afterwards one probe goes
 *   alone and without retry, and other calls stay `down` until it ends. A call
 *   that started before the availability changed only reports when it ends:
 *   it neither counts, nor opens, nor closes. Every retry asks again: once a
 *   parallel call over the same caller moved the service to `down` or to its
 *   probe, the call ends as `down` without reaching the service.
 * - Event: one `external_call` per call with closed fields only. No message,
 *   argument or answer of the service ever goes into it, so a key, password
 *   or address has nowhere to travel.
 */

export const EXTERNAL_SERVICES = ["storage", "keys", "email"] as const;
export type ExternalService = (typeof EXTERNAL_SERVICES)[number];

export const EXTERNAL_CALL_OUTCOMES = ["ok", "failed", "timeout", "down"] as const;
export type ExternalCallOutcome = (typeof EXTERNAL_CALL_OUTCOMES)[number];
export type ExternalCallFailure = Exclude<ExternalCallOutcome, "ok">;

export type ExternalCallEvent = {
  readonly event: "external_call";
  readonly service: ExternalService;
  readonly operation: string;
  readonly outcome: ExternalCallOutcome;
  readonly attempts: number;
  readonly durationMs: number;
};

export type ExternalCallPolicy = {
  readonly timeoutMs: number;
  readonly retries: number;
  readonly retryDelayMs: number;
  readonly downAfter: number;
  readonly downForMs: number;
};

export type ExternalCallDeps = {
  readonly now?: () => number;
  /** Resolves after `ms`; an abort rejects it. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** May be async; a throw or a rejection never reaches the caller. */
  readonly onEvent?: (event: ExternalCallEvent) => unknown;
};

/** `answer` is the service's own last answer when it answered but `failed` said no. */
export type ExternalCallResult<T> =
  { ok: true; value: T } | { ok: false; failure: ExternalCallFailure; answer?: T };

export type ExternalCallOptions<T> = {
  /** The operation is idempotent and may be sent again within the deadline. */
  readonly retry?: boolean;
  /** An answer that means the service failed (e.g. `unavailable`). */
  readonly failed?: (value: T) => boolean;
};

export type ExternalCaller = {
  call<T>(
    operation: string,
    run: (signal: AbortSignal) => Promise<T>,
    options?: ExternalCallOptions<T>,
  ): Promise<ExternalCallResult<T>>;
  availability(): "available" | "down";
};

const OPERATION_RE = /^[a-z][a-z0-9_]{0,39}$/;

function timerSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(timer), reject(signal.reason)), {
      once: true,
    });
  });
}

/** The longest delay `setTimeout` keeps; a longer one fires at once. */
const TIMER_MAX_MS = 2 ** 31 - 1;
const POLICY_LIMITS: Readonly<Record<keyof ExternalCallPolicy, readonly [number, number]>> = {
  timeoutMs: [1, TIMER_MAX_MS],
  retries: [0, Number.MAX_SAFE_INTEGER],
  retryDelayMs: [0, TIMER_MAX_MS],
  downAfter: [1, Number.MAX_SAFE_INTEGER],
  downForMs: [0, Number.MAX_SAFE_INTEGER],
};

/**
 * A plain record (prototype `Object.prototype` or none) with exactly the five
 * own data keys, each a whole number in its range. Returns a frozen copy of
 * the checked values: a later change of the object, or a proxy that answers
 * differently on another read, cannot reach the caller.
 */
function checkPolicy(policy: unknown): ExternalCallPolicy {
  if (typeof policy !== "object" || policy === null || Array.isArray(policy))
    throw new RangeError("policy must be a plain object");
  const proto: unknown = Object.getPrototypeOf(policy);
  if (proto !== Object.prototype && proto !== null)
    throw new RangeError("policy must be a plain object");
  const keys = Reflect.ownKeys(policy);
  for (const key of keys)
    if (typeof key !== "string" || !Object.hasOwn(POLICY_LIMITS, key))
      throw new RangeError(`policy has an unknown key: ${String(key)}`);
  const checked: Record<string, number> = {};
  for (const [key, [min, max]] of Object.entries(POLICY_LIMITS)) {
    const value: unknown = Object.getOwnPropertyDescriptor(policy, key)?.value;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max)
      throw new RangeError(`${key} must be a whole number from ${min} to ${max}`);
    checked[key] = value;
  }
  return Object.freeze(checked as ExternalCallPolicy);
}

/** Only an own data property counts: nothing inherited from a prototype. */
function own(options: object, key: "retry" | "failed"): unknown {
  return Object.getOwnPropertyDescriptor(options, key)?.value;
}

export function createExternalCaller(
  service: ExternalService,
  policy: ExternalCallPolicy,
  deps: ExternalCallDeps = {},
): ExternalCaller {
  if (!(EXTERNAL_SERVICES as readonly unknown[]).includes(service))
    throw new RangeError("service must be one of the closed list");
  const checked = checkPolicy(policy);
  // Monotonic by default: a jump of the wall clock moves no deadline.
  const now = deps.now ?? (() => performance.now());
  const sleep = deps.sleep ?? timerSleep;
  // closed: calls go through; open: calls are `down` until `until`; probing:
  // one call goes alone and every other call is `down`. Each change of state
  // starts a new epoch, and only a call that ends in its own epoch moves it.
  type Breaker =
    | { readonly state: "closed"; readonly failures: number }
    | { readonly state: "open"; readonly until: number }
    | { readonly state: "probing" };
  let breaker: Breaker = { state: "closed", failures: 0 };
  let epoch = 0;
  const enter = (next: Breaker): void => {
    breaker = next;
    epoch += 1;
  };

  /** `down`, or the epoch the call runs in and whether it is the probe. */
  const admit = (at: number): "down" | { epoch: number; probe: boolean } => {
    if (breaker.state === "probing") return "down";
    if (breaker.state === "open") {
      if (at < breaker.until) return "down";
      enter({ state: "probing" });
      return { epoch, probe: true };
    }
    return { epoch, probe: false };
  };

  const settle = (started: number, ok: boolean): void => {
    if (started !== epoch) return; // a stale call only reports
    if (ok) {
      if (breaker.state === "probing") enter({ state: "closed", failures: 0 });
      else breaker = { state: "closed", failures: 0 };
      return;
    }
    const failures = breaker.state === "closed" ? breaker.failures + 1 : checked.downAfter;
    if (failures >= checked.downAfter) enter({ state: "open", until: now() + checked.downForMs });
    else breaker = { state: "closed", failures };
  };

  const report = (
    operation: string,
    outcome: ExternalCallOutcome,
    attempts: number,
    start: number,
  ) => {
    const event: ExternalCallEvent = {
      event: "external_call",
      service,
      operation,
      outcome,
      attempts,
      durationMs: Math.max(0, Math.round(now() - start)),
    };
    try {
      const written = deps.onEvent?.(event);
      // An async sink is not awaited, but its rejection is consumed.
      if (written instanceof Promise) written.catch(() => {});
    } catch {
      // An event that cannot be written must not change the answer.
    }
  };

  async function attempt<T>(run: (s: AbortSignal) => Promise<T>, signal: AbortSignal) {
    try {
      return { done: true as const, value: await run(signal) };
    } catch {
      return { done: false as const };
    }
  }

  async function call<T>(
    operation: string,
    run: (signal: AbortSignal) => Promise<T>,
    options: object,
  ): Promise<ExternalCallResult<T>> {
    const start = now();
    const admitted = admit(start);
    if (admitted === "down") {
      report(operation, "down", 0, start);
      return { ok: false, failure: "down" };
    }
    let ok = false;
    try {
      const result = await guarded(operation, run, options, start, admitted);
      ok = result.ok;
      return result;
    } finally {
      // Also when something unforeseen threw: a probe never stays open-ended.
      settle(admitted.epoch, ok);
    }
  }

  async function guarded<T>(
    operation: string,
    run: (signal: AbortSignal) => Promise<T>,
    options: object,
    start: number,
    admitted: { epoch: number; probe: boolean },
  ): Promise<ExternalCallResult<T>> {
    const probe = admitted.probe;
    const retry = own(options, "retry") === true;
    const failedCheck = own(options, "failed");
    // A failed-check that is not a function throws, and a throw is a failure.
    const failed = (value: T): boolean =>
      failedCheck === undefined ? false : Boolean((failedCheck as (v: T) => unknown)(value));
    // A retry goes only while the breaker is where the call found it, or
    // closed again; open (expired or not) or probing means `down`.
    const blocked = (): boolean => admitted.epoch !== epoch && breaker.state !== "closed";
    const deadline = start + checked.timeoutMs;
    const work = new AbortController();
    const timer = new AbortController();
    let attempts = 0;
    let answered: { value: T } | undefined;

    // Armed first, for what is left of the deadline: no caller code has run yet.
    const expiry = sleep(Math.max(0, deadline - now()), timer.signal).then(
      (): ExternalCallResult<T> => ({ ok: false, failure: "timeout" }),
      () => new Promise<never>(() => {}),
    );
    const tries = (async (): Promise<ExternalCallResult<T>> => {
      for (;;) {
        // The deadline is absolute: no attempt starts at or after it, and an
        // answer that arrives after it is dropped, however the timers ran.
        if (now() >= deadline || work.signal.aborted) return { ok: false, failure: "timeout" };
        if (attempts > 0 && blocked()) return { ok: false, failure: "down" };
        attempts += 1;
        const result = await attempt(run, work.signal);
        const good = result.done && !failed(result.value);
        // Checked after the failed-check too: it is caller code and takes time.
        if (now() > deadline) return { ok: false, failure: "timeout" };
        if (good) return { ok: true, value: result.value };
        answered = result.done ? { value: result.value } : undefined;
        const more = !probe && retry && attempts <= checked.retries;
        if (more && blocked()) return { ok: false, failure: "down" };
        if (!more || now() + checked.retryDelayMs >= deadline || work.signal.aborted)
          return answered
            ? { ok: false, failure: "failed", answer: answered.value }
            : { ok: false, failure: "failed" };
        await sleep(checked.retryDelayMs, work.signal);
      }
    })();
    const result = await Promise.race([
      // A throw in caller code (the failed-check) is a failure, or a timeout once past the deadline.
      tries.catch((): ExternalCallResult<T> => ({
        ok: false,
        failure: now() > deadline ? "timeout" : "failed",
      })),
      expiry,
    ]);
    timer.abort();
    work.abort();
    report(operation, result.ok ? "ok" : result.failure, attempts, start);
    return result;
  }

  return {
    call(operation, run, options = {}) {
      if (typeof operation !== "string" || !OPERATION_RE.test(operation))
        throw new RangeError("operation must be a lower-case code");
      if (typeof options !== "object" || options === null)
        throw new RangeError("options must be an object");
      return call(operation, run, options);
    },
    availability: () =>
      breaker.state === "probing" || (breaker.state === "open" && now() < breaker.until)
        ? "down"
        : "available",
  };
}

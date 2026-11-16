/**
 * One pattern for every call to an outside service (S-1E-c, DAN-837): storage,
 * keys and email. Adapters in `external/` must not import one another
 * (docs/server-map.md §2), so the pattern lives here, next to the duration and
 * outcome it measures.
 *
 * - Deadline: a call never waits longer than `timeoutMs` from its start,
 *   retries included. The timer is armed before any caller code runs, so
 *   synchronous work in an adapter cannot push it back; a late answer is
 *   dropped and the attempt's signal is aborted.
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

function checkPolicy(policy: ExternalCallPolicy): void {
  const minimum = { timeoutMs: 1, retries: 0, retryDelayMs: 0, downAfter: 1, downForMs: 0 };
  for (const [key, min] of Object.entries(minimum)) {
    const value: unknown = policy[key as keyof ExternalCallPolicy];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min)
      throw new RangeError(`${key} must be a whole number >= ${min}`);
  }
}

export function createExternalCaller(
  service: ExternalService,
  policy: ExternalCallPolicy,
  deps: ExternalCallDeps = {},
): ExternalCaller {
  checkPolicy(policy);
  const now = deps.now ?? Date.now;
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
    const failures = breaker.state === "closed" ? breaker.failures + 1 : policy.downAfter;
    if (failures >= policy.downAfter) enter({ state: "open", until: now() + policy.downForMs });
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
      durationMs: Math.max(0, now() - start),
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
    options: ExternalCallOptions<T>,
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
    options: ExternalCallOptions<T>,
    start: number,
    admitted: { epoch: number; probe: boolean },
  ): Promise<ExternalCallResult<T>> {
    const probe = admitted.probe;
    // A retry goes only while the breaker is where the call found it, or
    // closed again; open (expired or not) or probing means `down`.
    const blocked = (): boolean => admitted.epoch !== epoch && breaker.state !== "closed";
    const deadline = start + policy.timeoutMs;
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
        const good = result.done && !options.failed?.(result.value);
        // Checked after the failed-check too: it is caller code and takes time.
        if (now() > deadline) return { ok: false, failure: "timeout" };
        if (good) return { ok: true, value: result.value };
        answered = result.done ? { value: result.value } : undefined;
        const more = !probe && options.retry === true && attempts <= policy.retries;
        if (more && blocked()) return { ok: false, failure: "down" };
        if (!more || now() + policy.retryDelayMs >= deadline || work.signal.aborted)
          return answered
            ? { ok: false, failure: "failed", answer: answered.value }
            : { ok: false, failure: "failed" };
        await sleep(policy.retryDelayMs, work.signal);
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
      if (!OPERATION_RE.test(operation))
        throw new RangeError("operation must be a lower-case code");
      return call(operation, run, options);
    },
    availability: () =>
      breaker.state === "probing" || (breaker.state === "open" && now() < breaker.until)
        ? "down"
        : "available",
  };
}

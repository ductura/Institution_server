/**
 * One pattern for every call to an outside service (S-1E-c, DAN-837): storage,
 * keys and email. Adapters in `external/` must not import one another
 * (docs/server-map.md §2), so the pattern lives here, next to the duration and
 * outcome it measures.
 *
 * - Deadline: a call never waits longer than `timeoutMs`, retries included; a
 *   late answer is dropped and the attempt's signal is aborted.
 * - Retry: only when the caller says the operation is idempotent, and only
 *   when the pause still ends before the deadline.
 * - Availability: after `downAfter` failed calls in a row the service is
 *   `down` for `downForMs` and calls do not reach it; the next call afterwards
 *   is one trial.
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
  readonly onEvent?: (event: ExternalCallEvent) => void;
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
  let failuresInRow = 0;
  let downUntil = Number.NEGATIVE_INFINITY;

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
      deps.onEvent?.(event);
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
    if (start < downUntil) {
      report(operation, "down", 0, start);
      return { ok: false, failure: "down" };
    }
    const deadline = start + policy.timeoutMs;
    const work = new AbortController();
    const timer = new AbortController();
    let attempts = 0;
    let answered: { value: T } | undefined;

    const tries = (async (): Promise<ExternalCallResult<T>> => {
      for (;;) {
        attempts += 1;
        const result = await attempt(run, work.signal);
        if (result.done && !options.failed?.(result.value))
          return { ok: true, value: result.value };
        answered = result.done ? { value: result.value } : undefined;
        const more = options.retry === true && attempts <= policy.retries;
        if (!more || now() + policy.retryDelayMs >= deadline || work.signal.aborted)
          return answered
            ? { ok: false, failure: "failed", answer: answered.value }
            : { ok: false, failure: "failed" };
        await sleep(policy.retryDelayMs, work.signal);
      }
    })();
    const expiry = sleep(policy.timeoutMs, timer.signal).then(
      (): ExternalCallResult<T> => ({ ok: false, failure: "timeout" }),
      () => new Promise<never>(() => {}),
    );
    const result = await Promise.race([
      tries.catch(() => ({ ok: false, failure: "failed" }) as const),
      expiry,
    ]);
    timer.abort();
    work.abort();

    if (result.ok) failuresInRow = 0;
    else if ((failuresInRow += 1) >= policy.downAfter) downUntil = now() + policy.downForMs;
    report(operation, result.ok ? "ok" : result.failure, attempts, start);
    return result;
  }

  return {
    call(operation, run, options = {}) {
      if (!OPERATION_RE.test(operation))
        throw new RangeError("operation must be a lower-case code");
      return call(operation, run, options);
    },
    availability: () => (now() < downUntil ? "down" : "available"),
  };
}

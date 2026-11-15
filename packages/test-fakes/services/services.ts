import { createFakeClock, type FakeClock } from "../clock/index.ts";

// An outside service as a `fetch` with no port (U9, DAN-741):
// - ok: answers 200 at once;
// - slow: answers 200 only after the clock has moved `delayMs`; an abort rejects;
// - down: fails as a network error, the way Node's fetch does.
export const FAKE_SERVICE_MODES = ["ok", "slow", "down"] as const;

export type FakeServiceMode = (typeof FAKE_SERVICE_MODES)[number];

export type FakeServiceOptions = {
  readonly mode: FakeServiceMode;
  /** How long `slow` waits on the clock; default 30 000 ms. */
  readonly delayMs?: number;
  /** The clock `slow` waits on; default a new fake clock. */
  readonly clock?: FakeClock;
  /** The JSON answer of `ok` and `slow`; default `{ "status": "ok" }`. */
  readonly body?: unknown;
};

export type FakeService = {
  readonly mode: FakeServiceMode;
  readonly clock: FakeClock;
  /** Every request seen, in order, `down` included. */
  readonly requests: readonly Request[];
  readonly fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
};

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("This operation was aborted", "AbortError");
}

export function createFakeService(options: FakeServiceOptions): FakeService {
  const { mode } = options;
  if (!(FAKE_SERVICE_MODES as readonly string[]).includes(mode))
    throw new Error(`fake service mode must be one of ${FAKE_SERVICE_MODES.join(", ")}: ${mode}`);
  const delayMs = options.delayMs ?? 30_000;
  if (!Number.isFinite(delayMs) || delayMs < 0)
    throw new RangeError(`delayMs must be a finite number >= 0: ${delayMs}`);
  const clock = options.clock ?? createFakeClock();
  const body = JSON.stringify(options.body ?? { status: "ok" });
  const requests: Request[] = [];

  const answer = (): Response =>
    new Response(body, { status: 200, headers: { "content-type": "application/json" } });

  return {
    mode,
    clock,
    requests,
    async fetch(input, init) {
      const request = new Request(input, init);
      requests.push(request);
      // As Node's fetch: an already aborted signal rejects in every mode.
      if (request.signal.aborted) throw abortReason(request.signal);
      if (mode === "down")
        throw new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED") });
      if (mode === "slow") await clock.sleep(delayMs, request.signal);
      return answer();
    },
  };
}

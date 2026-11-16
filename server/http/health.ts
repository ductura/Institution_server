// Health (S-1M-a, DAN-795; liveness ported from Ductus app/api/health/route.ts
// at d52a92c3, DAN-299): the process answers, with the versions the preloader
// needs and one word for the main database. Safe without a login: always 200
// and a closed body, never an address, a database name or an error, and
// never longer than CHECK_DEADLINE_MS. Readiness per capability is
// platform.ready.get.
import { API_VERSION, MIN_CLIENT_VERSION, ROUTES } from "../contracts/index.ts";

import type { Databases } from "./databases.ts";
import { type Route, sendJson } from "./router.ts";

const HEALTH_ID = "platform.health.get";
const found = ROUTES.find((route) => route.id === HEALTH_ID);
if (found === undefined) throw new Error(`no contract ${HEALTH_ID}`);
const contract = found;

/**
 * Longest wait for the main database. The registry gives up on its own check
 * after HEALTH_TIMEOUT_MS (2 s); this deadline holds even when that one does
 * not (a check that never settles).
 */
export const CHECK_DEADLINE_MS = 2_500;
/** How long one check answers every request, so a flood costs one check. */
export const CHECK_REUSE_MS = 1_000;

export type HealthState = "ok" | "degraded";

export type HealthOptions = {
  readonly health: Databases["health"];
  /** The version of this build (SERVER_VERSION in server/config). */
  readonly serverVersion: string;
  /** Milliseconds of a monotonic clock, for tests; performance.now by default. */
  readonly now?: () => number;
};

/** The health route over `health`: one check at a time, reused for CHECK_REUSE_MS. */
export function createHealthRoute(options: HealthOptions): Route {
  // Monotonic, so a wall clock stepped back never stretches the reuse.
  const now = options.now ?? (() => performance.now());
  let running: Promise<HealthState> | undefined;
  let last: { state: HealthState; at: number } | undefined;

  const check = async (): Promise<HealthState> => {
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<HealthState>((resolve) => {
      timer = setTimeout(() => resolve("degraded"), CHECK_DEADLINE_MS);
      timer.unref();
    });
    // Only the word of main counts; logs and legal have no say in health.
    // Any throw, also while reading the report, is `degraded`; nothing of
    // the error is kept or logged.
    const report = Promise.resolve()
      .then(async () => options.health())
      .then((states): HealthState => (states.main === "ok" ? "ok" : "degraded"))
      .catch((): HealthState => "degraded");
    try {
      return await Promise.race([report, deadline]);
    } finally {
      clearTimeout(timer);
    }
  };

  const state = async (): Promise<HealthState> => {
    // A negative age (a clock that went back) is expired too.
    const age = last === undefined ? -1 : now() - last.at;
    if (last !== undefined && age >= 0 && age < CHECK_REUSE_MS) return last.state;
    running ??= check()
      .then((found) => {
        last = { state: found, at: now() };
        return found;
      })
      .finally(() => {
        running = undefined;
      });
    return running;
  };

  return {
    contract,
    handle: async (_request, response) => {
      sendJson(response, 200, {
        status: "ok",
        state: await state(),
        apiVersion: API_VERSION,
        serverVersion: options.serverVersion,
        minClientVersion: MIN_CLIENT_VERSION,
      });
    },
  };
}
